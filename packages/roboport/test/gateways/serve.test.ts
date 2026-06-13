import { describe, expect, test } from 'bun:test';

import { Agent, Model, type ModelStreamEvent, type SearchHit } from '@/core';
import {
  memoryStore,
  serve,
  type Channel,
  type Gateway,
  type GatewayHandler,
  type InboundMessage,
} from '@/gateways';

class StubModel extends Model {
  private behavior: { reply?: string; throwError?: string };

  constructor(behavior: { reply?: string; throwError?: string } = {}) {
    super();
    this.behavior = behavior;
  }

  async *streamMessage(): AsyncIterable<ModelStreamEvent> {
    if (this.behavior.throwError) throw new Error(this.behavior.throwError);
    const reply = this.behavior.reply ?? 'ok';
    yield { type: 'text-delta', text: reply };
    yield { type: 'text-end', text: reply };
    yield {
      type: 'message-end',
      id: '1',
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  async searchWeb(): Promise<SearchHit[]> {
    return [];
  }
}

function stubAgent(
  behavior: { reply?: string; throwError?: string } = {},
): Agent {
  return new Agent({
    model: new StubModel(behavior),
    system: 'sys',
    tools: [],
    skills: [],
  });
}

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return { id: '1', conversationId: 'c1', text: 'hello', ...overrides };
}

function makeFakeGateway(): {
  gateway: Gateway<InboundMessage, Channel>;
  deliver: (message: InboundMessage) => void;
  sent: string[];
} {
  let handler: GatewayHandler<InboundMessage, Channel> | null = null;
  const sent: string[] = [];
  const gateway: Gateway<InboundMessage, Channel> = {
    name: 'fake',
    open(h: GatewayHandler<InboundMessage, Channel>): () => void {
      handler = h;
      return (): void => {};
    },
  };
  function deliver(message: InboundMessage): void {
    const channel: Channel = {
      conversationId: message.conversationId,
      send: async (text: string): Promise<void> => {
        sent.push(text);
      },
    };
    handler?.(message, channel);
  }
  return { gateway, deliver, sent };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await sleep(5);
  }
}

describe('serve', () => {
  test('runs a turn, relays the reply, persists user + assistant', async () => {
    const store = memoryStore();
    const { gateway, deliver, sent } = makeFakeGateway();
    serve(stubAgent({ reply: 'hi there' }), gateway, { store });

    deliver(inbound({ text: 'hello' }));
    await waitFor(() => sent.length === 1);

    expect(sent[0]).toBe('hi there');
    expect(await store.load('c1')).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
    ]);
  });

  test('serializes turns per conversation in arrival order', async () => {
    const store = memoryStore();
    const { gateway, deliver, sent } = makeFakeGateway();
    serve(stubAgent({ reply: 'r' }), gateway, { store });

    deliver(inbound({ text: 'first' }));
    deliver(inbound({ text: 'second' }));
    await waitFor(() => sent.length === 2);

    const stored = await store.load('c1');
    const userTexts = stored
      ?.filter((m) => m.role === 'user')
      .map((m) => (typeof m.content === 'string' ? m.content : ''));
    expect(userTexts).toEqual(['first', 'second']);
  });

  test('authorize=false drops the message without replying or persisting', async () => {
    const store = memoryStore();
    const { gateway, deliver, sent } = makeFakeGateway();
    serve(stubAgent(), gateway, { store, authorize: (): boolean => false });

    deliver(inbound());
    await sleep(50);

    expect(sent).toHaveLength(0);
    expect(await store.load('c1')).toBeNull();
  });

  test('prompt returning null skips the turn', async () => {
    const store = memoryStore();
    const { gateway, deliver, sent } = makeFakeGateway();
    serve(stubAgent(), gateway, { store, prompt: (): null => null });

    deliver(inbound());
    await sleep(50);

    expect(sent).toHaveLength(0);
    expect(await store.load('c1')).toBeNull();
  });

  test('onError receives a thrown turn error', async () => {
    const store = memoryStore();
    const { gateway, deliver } = makeFakeGateway();
    const errors: string[] = [];
    serve(stubAgent({ throwError: 'boom' }), gateway, {
      store,
      onError: (error: Error): void => {
        errors.push(error.message);
      },
    });

    deliver(inbound());
    await waitFor(() => errors.length === 1);

    expect(errors[0]).toBe('boom');
  });
});
