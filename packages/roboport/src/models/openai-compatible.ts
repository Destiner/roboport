import {
  Model,
  type CreateMessageParams,
  type Message,
  type ModelStreamEvent,
  type StopReason,
  type ThinkingLevel,
  type ThinkingPart,
} from '@/core';
import { readSse } from '@/core/stream';

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAIAssistantWireMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: OpenAIToolCall[];
}

type OpenAIWireMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | OpenAIAssistantWireMessage
  | { role: 'tool'; tool_call_id: string; content: string };

interface ChatCompletionsToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

interface ChatCompletionsDelta {
  role?: string;
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: ChatCompletionsToolCallDelta[];
  // Providers that don't follow the `reasoning_content` convention put their
  // reasoning elsewhere; subclasses read it via `createReasoningAccumulator`.
  [key: string]: unknown;
}

interface ChatCompletionsStreamChunk {
  id?: string;
  choices?: {
    delta?: ChatCompletionsDelta;
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

// Per-stream accumulator for providers whose reasoning arrives as structured
// payloads that must be echoed back verbatim on the next turn (OpenRouter's
// `reasoning_details`, say). Created fresh per `streamMessage` call so
// concurrent streams on one adapter instance don't share state.
interface ReasoningAccumulator {
  // Consume one streamed delta; return any plaintext reasoning to surface as a
  // `thinking-delta`, or undefined when the delta carries none.
  push(delta: ChatCompletionsDelta): string | undefined;
  // Opaque blob to hang off the resulting thinking part, replayed by
  // `adaptAssistantWire` on subsequent turns. Undefined when there's nothing
  // worth carrying.
  finish(): string | undefined;
}

interface ToolCallBuilder {
  id: string;
  name: string;
  argsBuffer: string;
}

function serializeToolOutput(output: unknown): string {
  if (output === undefined || output === null) return '';
  if (typeof output === 'string') return output;
  return JSON.stringify(output);
}

function mapFinishReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

function parseToolArguments(raw: string): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

abstract class OpenAICompatible extends Model {
  modelName: string;
  apiKey: string;
  baseUrl: string;
  thinking: ThinkingLevel;

  protected constructor(
    modelName: string,
    options: { apiKey: string; baseUrl: string; thinking?: ThinkingLevel },
  ) {
    super();
    this.modelName = modelName;
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
    this.thinking = options.thinking ?? 'off';
  }

  override async *streamMessage(
    params: CreateMessageParams,
  ): AsyncIterable<ModelStreamEvent> {
    const { messages, tools, maxTokens = 8192, signal } = params;
    const wireMessages = this.serializeMessages(messages);

    const wireTools = tools?.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.toJsonSchema(),
      },
    }));

    const body: Record<string, unknown> = {
      model: this.modelName,
      messages: wireMessages,
      max_completion_tokens: maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (wireTools !== undefined && wireTools.length > 0) body.tools = wireTools;
    this.applyThinking(body);

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
        accept: 'text/event-stream',
        ...this.extraHeaders(),
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      throw new Error(
        `Chat completions error ${response.status}: ${await response.text()}`,
      );
    }

    let id = '';
    let stopReason: StopReason = 'end_turn';
    let inputTokens = 0;
    let outputTokens = 0;
    let textOpen = false;
    let textBuffer = '';
    let thinkingOpen = false;
    let thinkingBuffer = '';
    let sawFinishReason = false;
    const toolBuilders = new Map<number, ToolCallBuilder>();
    const toolOrder: number[] = [];
    const reasoning = this.createReasoningAccumulator();

    // `redactedData` carries the provider's opaque reasoning payload, so the
    // next turn can replay it. Only computed once the thinking block closes.
    function thinkingEnd(text: string): ModelStreamEvent {
      const data = reasoning?.finish();
      return {
        type: 'thinking-end',
        text,
        ...(data !== undefined ? { redactedData: data } : {}),
      };
    }

    for await (const raw of readSse(response)) {
      const chunk = raw as ChatCompletionsStreamChunk;
      if (chunk.id && !id) id = chunk.id;
      if (chunk.usage) {
        if (chunk.usage.prompt_tokens !== undefined) {
          inputTokens = chunk.usage.prompt_tokens;
        }
        if (chunk.usage.completion_tokens !== undefined) {
          outputTokens = chunk.usage.completion_tokens;
        }
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;

      const delta = choice.delta;
      if (delta) {
        const reasoningText = reasoning
          ? reasoning.push(delta)
          : typeof delta.reasoning_content === 'string'
            ? delta.reasoning_content
            : undefined;
        if (reasoningText) {
          if (!thinkingOpen) thinkingOpen = true;
          thinkingBuffer += reasoningText;
          yield { type: 'thinking-delta', text: reasoningText };
        }

        const content = delta.content;
        if (typeof content === 'string' && content.length > 0) {
          if (thinkingOpen) {
            yield thinkingEnd(thinkingBuffer);
            thinkingOpen = false;
            thinkingBuffer = '';
          }
          if (!textOpen) textOpen = true;
          textBuffer += content;
          yield { type: 'text-delta', text: content };
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            let builder = toolBuilders.get(idx);
            if (!builder) {
              builder = {
                id: tc.id ?? '',
                name: tc.function?.name ?? '',
                argsBuffer: '',
              };
              toolBuilders.set(idx, builder);
              toolOrder.push(idx);
            }
            if (tc.id) builder.id = tc.id;
            if (tc.function?.name) builder.name = tc.function.name;
            if (tc.function?.arguments) {
              builder.argsBuffer += tc.function.arguments;
            }
          }
        }
      }

      if (choice.finish_reason) {
        stopReason = mapFinishReason(choice.finish_reason);
        sawFinishReason = true;
      }
    }

    if (!sawFinishReason) {
      throw new Error(
        'Chat completions stream ended without finish_reason; response is truncated.',
      );
    }

    if (textOpen) {
      yield { type: 'text-end', text: textBuffer };
    }
    if (thinkingOpen) {
      yield thinkingEnd(thinkingBuffer);
    }

    for (const idx of toolOrder) {
      const builder = toolBuilders.get(idx);
      if (!builder) continue;
      yield {
        type: 'tool-call',
        toolCallId: builder.id,
        toolName: builder.name,
        input: parseToolArguments(builder.argsBuffer),
      };
    }

    yield {
      type: 'message-end',
      id,
      stopReason,
      usage: { inputTokens, outputTokens },
    };
  }

  protected serializeMessages(messages: Message[]): OpenAIWireMessage[] {
    const wire: OpenAIWireMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        wire.push({ role: 'system', content: msg.content });
        continue;
      }

      if (msg.role === 'user') {
        const content =
          typeof msg.content === 'string'
            ? msg.content
            : msg.content.map((part) => part.text).join('\n');
        wire.push({ role: 'user', content });
        continue;
      }

      if (msg.role === 'assistant') {
        const texts: string[] = [];
        const toolCalls: OpenAIToolCall[] = [];
        const thinking: ThinkingPart[] = [];

        for (const part of msg.content) {
          if (part.type === 'text') {
            texts.push(part.text);
          } else if (part.type === 'tool-call') {
            toolCalls.push({
              id: part.toolCallId,
              type: 'function',
              function: {
                name: part.toolName,
                arguments: JSON.stringify(part.input ?? {}),
              },
            });
          } else {
            // No portable chat-completions representation, so the base drops
            // thinking; `adaptAssistantWire` gets them in case the provider
            // has one (and requires the round-trip).
            thinking.push(part);
          }
        }

        const assistantMsg: OpenAIAssistantWireMessage = {
          role: 'assistant',
          content: texts.length > 0 ? texts.join('\n') : null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        };
        wire.push(this.adaptAssistantWire(assistantMsg, thinking));
        continue;
      }

      for (const part of msg.content) {
        wire.push({
          role: 'tool',
          tool_call_id: part.toolCallId,
          content: serializeToolOutput(part.output),
        });
      }
    }

    return wire;
  }

  protected adaptAssistantWire(
    msg: OpenAIAssistantWireMessage,
    thinking?: ThinkingPart[],
  ): OpenAIAssistantWireMessage {
    void thinking;
    return msg;
  }

  // Extra request headers (attribution, provider routing). Merged after the
  // standard ones, so a subclass can also override them.
  protected extraHeaders(): Record<string, string> {
    return {};
  }

  // Hook for providers whose reasoning does not arrive as `reasoning_content`,
  // or that require the reasoning payload to be echoed back on later turns.
  // Returning undefined keeps the plain `reasoning_content` behaviour.
  protected createReasoningAccumulator(): ReasoningAccumulator | undefined {
    return undefined;
  }

  // Hook for subclasses to map the unified `thinking` level onto provider-
  // specific request fields (e.g. `reasoning_effort`, `enable_thinking`).
  // Default is a no-op so chat-completions servers that don't understand any
  // reasoning fields keep working.
  protected applyThinking(body: Record<string, unknown>): void {
    void body;
  }
}

export {
  OpenAICompatible,
  type ChatCompletionsDelta,
  type OpenAIAssistantWireMessage,
  type ReasoningAccumulator,
};
