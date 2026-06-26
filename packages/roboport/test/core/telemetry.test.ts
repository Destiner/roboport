import { afterEach, beforeAll, describe, expect, test } from 'bun:test';

import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

import {
  Agent,
  Model,
  Tool,
  type ModelStreamEvent,
  type SearchHit,
} from '@/core';

// A model that asks for one tool call, then replies with text — exercising a
// two-round agent loop (model -> tool -> model).
class ToolCallingModel extends Model {
  modelName = 'test-model';
  private calls = 0;

  async *streamMessage(): AsyncIterable<ModelStreamEvent> {
    this.calls += 1;
    if (this.calls === 1) {
      yield {
        type: 'tool-call',
        toolCallId: 't1',
        toolName: 'echo',
        input: {},
      };
      yield {
        type: 'message-end',
        id: 'm1',
        stopReason: 'tool_use',
        usage: { inputTokens: 10, outputTokens: 5 },
      };
      return;
    }
    yield { type: 'text-end', text: 'done' };
    yield {
      type: 'message-end',
      id: 'm2',
      stopReason: 'end_turn',
      usage: { inputTokens: 3, outputTokens: 7 },
    };
  }

  async searchWeb(): Promise<SearchHit[]> {
    return [];
  }
}

const echo = new Tool({
  name: 'echo',
  description: 'echo',
  jsonSchema: { type: 'object', properties: {} },
  execute: (): string => 'done',
});

const exporter = new InMemorySpanExporter();

function parentSpanId(span: ReadableSpan): string | undefined {
  return span.parentSpanContext?.spanId;
}

async function runTurn(): Promise<ReadableSpan[]> {
  const agent = new Agent({
    model: new ToolCallingModel(),
    system: 'sys',
    tools: [echo],
    skills: [],
  });
  const session = agent.session();
  await session.send('hi');
  await session.close();
  return exporter.getFinishedSpans();
}

beforeAll(() => {
  // An AsyncLocalStorage-based context manager is what makes startActiveSpan
  // propagate the active context across awaits, so nesting can be asserted.
  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  );
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    }),
  );
});

afterEach(() => {
  exporter.reset();
});

describe('telemetry', () => {
  test('nests model and tool spans under a single agent.turn trace', async () => {
    const spans = await runTurn();
    function named(name: string): ReadableSpan[] {
      return spans.filter((s) => s.name === name);
    }

    expect(named('agent.turn')).toHaveLength(1);
    expect(named('chat.model')).toHaveLength(2);
    expect(named('tool.execute')).toHaveLength(1);

    // A single trace: if chat.model detached to its own root (the bug the
    // active-context fix addresses), there would be more than one trace id.
    const traceIds = new Set(spans.map((s) => s.spanContext().traceId));
    expect(traceIds.size).toBe(1);

    const turn = named('agent.turn')[0]!;
    expect(parentSpanId(turn)).toBeUndefined();
    const turnId = turn.spanContext().spanId;
    for (const child of [...named('chat.model'), ...named('tool.execute')]) {
      expect(parentSpanId(child)).toBe(turnId);
    }
  });

  test('sets GenAI attributes on model and tool spans', async () => {
    const spans = await runTurn();

    const modelSpans = spans.filter((s) => s.name === 'chat.model');
    for (const span of modelSpans) {
      expect(span.attributes['gen_ai.operation.name']).toBe('chat');
      expect(span.attributes['gen_ai.request.model']).toBe('test-model');
      expect(typeof span.attributes['gen_ai.usage.input_tokens']).toBe(
        'number',
      );
    }
    // `gen_ai.response.finish_reasons` is an array per the GenAI conventions.
    const finishReasons = modelSpans
      .map((s) => s.attributes['gen_ai.response.finish_reasons'])
      .flat();
    expect(finishReasons).toContain('tool_use');
    expect(finishReasons).toContain('end_turn');

    const toolSpan = spans.find((s) => s.name === 'tool.execute')!;
    expect(toolSpan.attributes['gen_ai.tool.name']).toBe('echo');
    expect(toolSpan.attributes['gen_ai.tool.call.id']).toBe('t1');
  });
});
