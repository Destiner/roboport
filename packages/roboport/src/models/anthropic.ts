import {
  Model,
  type CreateMessageParams,
  type LiteralUnion,
  type Message,
  type ModelStreamEvent,
  type SearchHit,
  type SearchOptions,
  type StopReason,
  type ThinkingLevel,
} from '@/core';
import { readSse } from '@/core/stream';
import { env } from '@/env';

const ANTHROPIC_MODELS = [
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
] as const;

type AnthropicModelName = LiteralUnion<(typeof ANTHROPIC_MODELS)[number]>;

// Budget table anchors low/medium/high to Claude Code's `think`/`megathink`/
// `ultrathink` keywords (4_000 / 10_000 / 31_999). `minimal` is the API floor;
// `xhigh` exceeds Claude Code's ceiling but stays under the 64K `max_tokens`
// cap once `ANTHROPIC_OUTPUT_BUFFER` is added on top.
const ANTHROPIC_BUDGETS: Record<Exclude<ThinkingLevel, 'off'>, number> = {
  minimal: 1_024,
  low: 4_000,
  medium: 10_000,
  high: 31_999,
  xhigh: 50_000,
};
const ANTHROPIC_OUTPUT_BUFFER = 4_096;

// Opus 4.7 and later only accept the adaptive thinking format with an effort
// level in `output_config`. Older models keep the legacy enabled+budget shape.
const ADAPTIVE_THINKING_MODELS = new Set<string>([
  'claude-opus-4-7',
  'claude-opus-4-8',
] satisfies (typeof ANTHROPIC_MODELS)[number][]);

const ADAPTIVE_EFFORTS: Record<
  Exclude<ThinkingLevel, 'off'>,
  'minimal' | 'low' | 'medium' | 'high'
> = {
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
};

type AnthropicWireContent =
  | { type: 'text'; text: string }
  | {
      type: 'thinking';
      thinking: string;
      signature: string;
    }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };

interface AnthropicWireMessage {
  role: 'user' | 'assistant';
  content: AnthropicWireContent[];
}

interface WebSearchResultBlock {
  type: 'web_search_result';
  url: string;
  title: string;
  page_age?: string | null;
  encrypted_content?: string;
}

type AnthropicStreamEvent =
  | {
      type: 'message_start';
      message: {
        id: string;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
    }
  | {
      type: 'content_block_start';
      index: number;
      content_block:
        | { type: 'text'; text?: string }
        | { type: 'thinking'; thinking?: string }
        | { type: 'redacted_thinking'; data: string }
        | { type: 'tool_use'; id: string; name: string; input?: unknown };
    }
  | {
      type: 'content_block_delta';
      index: number;
      delta:
        | { type: 'text_delta'; text: string }
        | { type: 'thinking_delta'; thinking: string }
        | { type: 'signature_delta'; signature: string }
        | { type: 'input_json_delta'; partial_json: string };
    }
  | { type: 'content_block_stop'; index: number }
  | {
      type: 'message_delta';
      delta: { stop_reason?: StopReason };
      usage?: { input_tokens?: number; output_tokens?: number };
    }
  | { type: 'message_stop' }
  | { type: 'ping' }
  | { type: 'error'; error?: { message?: string } };

interface BlockBuilder {
  kind: 'text' | 'thinking' | 'redacted_thinking' | 'tool_use';
  text: string;
  signature?: string;
  redactedData?: string;
  toolCallId?: string;
  toolName?: string;
  argsBuffer?: string;
}

function serializeToolOutput(output: unknown): string {
  if (output === undefined || output === null) return '';
  if (typeof output === 'string') return output;
  return JSON.stringify(output);
}

function toWire(messages: Message[]): {
  system: string | undefined;
  wireMessages: AnthropicWireMessage[];
} {
  let system: string | undefined;
  const wireMessages: AnthropicWireMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      system = msg.content;
      continue;
    }

    if (msg.role === 'user') {
      const content: AnthropicWireContent[] =
        typeof msg.content === 'string'
          ? [{ type: 'text', text: msg.content }]
          : msg.content.map((part) => ({ type: 'text', text: part.text }));
      wireMessages.push({ role: 'user', content });
      continue;
    }

    if (msg.role === 'assistant') {
      const content: AnthropicWireContent[] = [];
      for (const part of msg.content) {
        if (part.type === 'text') {
          content.push({ type: 'text', text: part.text });
          continue;
        }
        if (part.type === 'thinking') {
          // Only emit thinking blocks the model itself signed (or marked
          // redacted). Unsigned parts — usually hand-constructed or imported
          // from another provider — cannot be replayed: Anthropic rejects
          // `thinking` blocks without a valid signature.
          if (part.redactedData !== undefined) {
            content.push({
              type: 'redacted_thinking',
              data: part.redactedData,
            });
          } else if (part.signature !== undefined && part.signature !== '') {
            content.push({
              type: 'thinking',
              thinking: part.text,
              signature: part.signature,
            });
          }
          continue;
        }
        content.push({
          type: 'tool_use',
          id: part.toolCallId,
          name: part.toolName,
          input: part.input,
        });
      }
      wireMessages.push({ role: 'assistant', content });
      continue;
    }

    wireMessages.push({
      role: 'user',
      content: msg.content.map((part) => ({
        type: 'tool_result',
        tool_use_id: part.toolCallId,
        content: serializeToolOutput(part.output),
      })),
    });
  }

  return { system, wireMessages };
}

class AnthropicModel extends Model {
  modelName: string;
  apiKey: string;
  thinking: ThinkingLevel;

  constructor(
    modelName: AnthropicModelName,
    options?: { apiKey?: string; thinking?: ThinkingLevel },
  ) {
    super();
    this.modelName = modelName;
    const key = options?.apiKey ?? env.anthropicApiKey;
    if (!key) {
      throw new Error(
        'No Anthropic API key found. Set ANTHROPIC_API_KEY or pass apiKey.',
      );
    }
    this.apiKey = key;
    this.thinking = options?.thinking ?? 'off';
  }

  override async *streamMessage(
    params: CreateMessageParams,
  ): AsyncIterable<ModelStreamEvent> {
    const { messages, tools, maxTokens = 8192, signal } = params;
    const { system, wireMessages } = toWire(messages);

    const wireTools = tools?.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.toJsonSchema(),
    }));

    const useAdaptive = ADAPTIVE_THINKING_MODELS.has(this.modelName);
    const budget =
      this.thinking === 'off' || useAdaptive
        ? undefined
        : ANTHROPIC_BUDGETS[this.thinking];
    // Anthropic requires max_tokens > budget_tokens; keep at least
    // ANTHROPIC_OUTPUT_BUFFER tokens of room for the actual response.
    const effectiveMaxTokens =
      budget === undefined
        ? maxTokens
        : Math.max(maxTokens, budget + ANTHROPIC_OUTPUT_BUFFER);

    const body: Record<string, unknown> = {
      model: this.modelName,
      max_tokens: effectiveMaxTokens,
      messages: wireMessages,
      stream: true,
    };
    if (system !== undefined) body.system = system;
    if (wireTools !== undefined && wireTools.length > 0) body.tools = wireTools;
    if (budget !== undefined) {
      body.thinking = { type: 'enabled', budget_tokens: budget };
    } else if (useAdaptive && this.thinking !== 'off') {
      body.thinking = { type: 'adaptive' };
      body.output_config = { effort: ADAPTIVE_EFFORTS[this.thinking] };
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      throw new Error(
        `Anthropic API error ${response.status}: ${await response.text()}`,
      );
    }

    const blocks = new Map<number, BlockBuilder>();
    let id = '';
    let stopReason: StopReason = 'end_turn';
    let inputTokens = 0;
    let outputTokens = 0;
    let sawMessageStop = false;

    for await (const raw of readSse(response)) {
      const event = raw as AnthropicStreamEvent;

      if (event.type === 'message_start') {
        id = event.message.id;
        if (event.message.usage?.input_tokens !== undefined) {
          inputTokens = event.message.usage.input_tokens;
        }
        if (event.message.usage?.output_tokens !== undefined) {
          outputTokens = event.message.usage.output_tokens;
        }
        continue;
      }

      if (event.type === 'content_block_start') {
        const block = event.content_block;
        if (block.type === 'text') {
          blocks.set(event.index, { kind: 'text', text: block.text ?? '' });
        } else if (block.type === 'thinking') {
          blocks.set(event.index, {
            kind: 'thinking',
            text: block.thinking ?? '',
          });
        } else if (block.type === 'redacted_thinking') {
          blocks.set(event.index, {
            kind: 'redacted_thinking',
            text: '',
            redactedData: block.data,
          });
        } else if (block.type === 'tool_use') {
          blocks.set(event.index, {
            kind: 'tool_use',
            text: '',
            toolCallId: block.id,
            toolName: block.name,
            argsBuffer: '',
          });
        }
        continue;
      }

      if (event.type === 'content_block_delta') {
        const builder = blocks.get(event.index);
        if (!builder) continue;
        const delta = event.delta;
        if (delta.type === 'text_delta') {
          builder.text += delta.text;
          yield { type: 'text-delta', text: delta.text };
        } else if (delta.type === 'thinking_delta') {
          builder.text += delta.thinking;
          yield { type: 'thinking-delta', text: delta.thinking };
        } else if (delta.type === 'signature_delta') {
          builder.signature = (builder.signature ?? '') + delta.signature;
        } else if (delta.type === 'input_json_delta') {
          builder.argsBuffer = (builder.argsBuffer ?? '') + delta.partial_json;
        }
        continue;
      }

      if (event.type === 'content_block_stop') {
        const builder = blocks.get(event.index);
        if (!builder) continue;
        if (builder.kind === 'text') {
          yield { type: 'text-end', text: builder.text };
        } else if (builder.kind === 'thinking') {
          yield {
            type: 'thinking-end',
            text: builder.text,
            ...(builder.signature !== undefined
              ? { signature: builder.signature }
              : {}),
          };
        } else if (builder.kind === 'redacted_thinking') {
          yield {
            type: 'thinking-end',
            text: '',
            redactedData: builder.redactedData,
          };
        } else if (builder.kind === 'tool_use') {
          const input = parseToolInput(builder.argsBuffer ?? '');
          yield {
            type: 'tool-call',
            toolCallId: builder.toolCallId ?? '',
            toolName: builder.toolName ?? '',
            input,
          };
        }
        blocks.delete(event.index);
        continue;
      }

      if (event.type === 'message_delta') {
        if (event.delta.stop_reason) stopReason = event.delta.stop_reason;
        if (event.usage?.input_tokens !== undefined) {
          inputTokens = event.usage.input_tokens;
        }
        if (event.usage?.output_tokens !== undefined) {
          outputTokens = event.usage.output_tokens;
        }
        continue;
      }

      if (event.type === 'message_stop') {
        sawMessageStop = true;
        continue;
      }

      if (event.type === 'error') {
        throw new Error(
          event.error?.message ?? 'Anthropic stream returned an error.',
        );
      }
    }

    if (!sawMessageStop) {
      throw new Error(
        'Anthropic stream ended before message_stop; response is truncated.',
      );
    }

    yield {
      type: 'message-end',
      id,
      stopReason,
      usage: { inputTokens, outputTokens },
    };
  }

  override async searchWeb(
    query: string,
    opts?: SearchOptions,
  ): Promise<SearchHit[]> {
    const tool: Record<string, unknown> = {
      type: 'web_search_20250305',
      name: 'web_search',
    };
    if (opts?.allowedDomains) tool.allowed_domains = opts.allowedDomains;
    if (opts?.blockedDomains) tool.blocked_domains = opts.blockedDomains;
    if (opts?.maxUses !== undefined) tool.max_uses = opts.maxUses;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.modelName,
        max_tokens: 1024,
        tools: [tool],
        messages: [{ role: 'user', content: `Search the web for: ${query}` }],
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Anthropic web_search failed (${response.status}): ${await response.text()}`,
      );
    }

    const json = (await response.json()) as {
      content: ({ type: string } & Record<string, unknown>)[];
    };

    const hits: SearchHit[] = [];
    for (const block of json.content) {
      if (block.type !== 'web_search_tool_result') continue;
      const content = block.content as WebSearchResultBlock[] | undefined;
      if (!Array.isArray(content)) continue;
      for (const item of content) {
        if (item.type !== 'web_search_result') continue;
        hits.push({
          title: item.title,
          url: item.url,
          pageAge: item.page_age ?? undefined,
        });
      }
    }
    return hits;
  }
}

function parseToolInput(raw: string): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export { AnthropicModel, ANTHROPIC_MODELS };
