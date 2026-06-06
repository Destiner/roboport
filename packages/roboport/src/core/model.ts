import type { TextPart, ThinkingPart, ToolCallPart } from './message';
import type { ModelStreamEvent } from './stream';
import type {
  CreateMessageParams,
  CreateMessageResponse,
  SearchHit,
  SearchOptions,
  StopReason,
} from './tool';

// Preserves literal autocompletion in `T | string` unions: the `& {}` branch
// stops TypeScript from widening the whole union to `string`, while still
// accepting any string at the call site.
type LiteralUnion<T extends string> = T | (string & {});

// Unified reasoning-effort scale across providers. Matches the Codex CLI enum
// and `pi-mono`. Each model adapter is responsible for mapping a level onto
// the provider's wire format (or collapsing/dropping levels the provider does
// not support).
type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

abstract class Model {
  abstract streamMessage(
    params: CreateMessageParams,
  ): AsyncIterable<ModelStreamEvent>;

  abstract searchWeb(query: string, opts?: SearchOptions): Promise<SearchHit[]>;

  // Non-streaming convenience: drains streamMessage and assembles a complete
  // response. Adapters can override if they have a cheaper non-streaming
  // wire path, but the default works for any provider with streaming.
  async createMessage(
    params: CreateMessageParams,
  ): Promise<CreateMessageResponse> {
    const content: (TextPart | ThinkingPart | ToolCallPart)[] = [];
    let id = '';
    let stopReason: StopReason = 'end_turn';
    let usage = { inputTokens: 0, outputTokens: 0 };

    for await (const event of this.streamMessage(params)) {
      switch (event.type) {
        case 'text-end':
          content.push({ type: 'text', text: event.text });
          break;
        case 'thinking-end':
          content.push({
            type: 'thinking',
            text: event.text,
            ...(event.signature !== undefined
              ? { signature: event.signature }
              : {}),
            ...(event.redactedData !== undefined
              ? { redactedData: event.redactedData }
              : {}),
          });
          break;
        case 'tool-call':
          content.push({
            type: 'tool-call',
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: event.input,
          });
          break;
        case 'message-end':
          id = event.id;
          stopReason = event.stopReason;
          usage = event.usage;
          break;
        default:
          break;
      }
    }

    return { id, content, stopReason, usage };
  }
}

export { Model, type LiteralUnion, type ThinkingLevel };
