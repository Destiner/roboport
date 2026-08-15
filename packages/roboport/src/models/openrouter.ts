import type {
  LiteralUnion,
  SearchHit,
  SearchOptions,
  ThinkingLevel,
  ThinkingPart,
} from '@/core';
import { env } from '@/env';

import {
  OpenAICompatible,
  type ChatCompletionsDelta,
  type OpenAIAssistantWireMessage,
  type ReasoningAccumulator,
} from './openai-compatible';

// A sampling of models for autocomplete; OpenRouter's catalogue is far larger
// and any `author/slug` string is accepted (LiteralUnion keeps it open).
const OPENROUTER_MODELS = [
  'openai/gpt-5.6-luna',
  'openai/gpt-5.6-luna-pro',
  'openai/gpt-5.6-sol',
  'openai/gpt-5.6-terra',
  'anthropic/claude-opus-4.7',
  'anthropic/claude-sonnet-4.7',
  'google/gemini-3.1-pro',
  'moonshotai/kimi-k2.6',
] as const;

type OpenRouterModelName = LiteralUnion<(typeof OPENROUTER_MODELS)[number]>;

interface OpenRouterOptions {
  apiKey?: string;
  baseUrl?: string;
  thinking?: ThinkingLevel;
  // Sent as `HTTP-Referer` / `X-Title`; OpenRouter uses them to attribute
  // usage on its dashboards and leaderboards. Both optional.
  referer?: string;
  title?: string;
}

// One entry of OpenRouter's structured reasoning payload. The fields vary by
// type (`reasoning.text`, `reasoning.summary`, `reasoning.encrypted`), so only
// the ones needed to merge streamed deltas are typed.
interface ReasoningDetail {
  type?: string;
  index?: number;
  text?: string;
  summary?: string;
  data?: string;
  [key: string]: unknown;
}

interface OpenRouterAnnotation {
  type?: string;
  url_citation?: {
    url?: string;
    title?: string;
    content?: string;
  };
}

interface OpenRouterChatResponse {
  choices?: {
    message?: {
      content?: string | null;
      annotations?: OpenRouterAnnotation[];
    };
  }[];
}

// Which of a detail's fields carries incremental text. Deltas for the same
// `index` append; everything else on the entry is last-write-wins.
const TEXT_FIELDS = ['text', 'summary'] as const;

// OpenRouter streams `reasoning_details` as partial entries keyed by `index`,
// alongside a plaintext `reasoning` string. Merge the entries so the complete
// payload can be replayed on the next turn, and surface the plaintext (falling
// back to whatever text the details carry) as thinking deltas.
function reasoningAccumulator(): ReasoningAccumulator {
  const byIndex = new Map<number, ReasoningDetail>();
  const order: number[] = [];

  return {
    push(delta: ChatCompletionsDelta): string | undefined {
      let text: string | undefined;

      const plain = delta.reasoning;
      if (typeof plain === 'string' && plain.length > 0) text = plain;

      const details = delta.reasoning_details;
      if (Array.isArray(details)) {
        for (const raw of details as ReasoningDetail[]) {
          if (!raw || typeof raw !== 'object') continue;
          const index = typeof raw.index === 'number' ? raw.index : 0;
          let entry = byIndex.get(index);
          if (!entry) {
            entry = { index };
            byIndex.set(index, entry);
            order.push(index);
          }
          for (const [key, value] of Object.entries(raw)) {
            if (
              (TEXT_FIELDS as readonly string[]).includes(key) &&
              typeof value === 'string'
            ) {
              const prev = entry[key];
              entry[key] = typeof prev === 'string' ? prev + value : value;
              // Only stand in for the plaintext channel when it's absent.
              if (text === undefined && value.length > 0) text = value;
              continue;
            }
            if (value !== undefined) entry[key] = value;
          }
        }
      }

      return text;
    },

    finish(): string | undefined {
      if (order.length === 0) return undefined;
      const merged = order
        .map((index) => byIndex.get(index))
        .filter((entry): entry is ReasoningDetail => entry !== undefined);
      return JSON.stringify(merged);
    },
  };
}

class OpenRouter extends OpenAICompatible {
  private referer?: string;
  private title?: string;

  constructor(modelName: OpenRouterModelName, options?: OpenRouterOptions) {
    const key = options?.apiKey ?? env.openRouterApiKey;
    if (!key) {
      throw new Error(
        'No OpenRouter API key found. Set OPENROUTER_API_KEY or pass apiKey.',
      );
    }
    super(modelName, {
      apiKey: key,
      baseUrl: options?.baseUrl ?? 'https://openrouter.ai/api/v1',
      thinking: options?.thinking,
    });
    if (options?.referer) this.referer = options.referer;
    if (options?.title) this.title = options.title;
  }

  protected override extraHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.referer) headers['http-referer'] = this.referer;
    if (this.title) headers['x-title'] = this.title;
    return headers;
  }

  // OpenRouter normalises reasoning across providers behind a single
  // `reasoning` object whose `effort` accepts exactly the unified scale, so
  // every level passes straight through. `off` sends nothing at all rather
  // than `effort: 'none'`, matching the other adapters — a non-reasoning model
  // then sees an unmodified request.
  protected override applyThinking(body: Record<string, unknown>): void {
    if (this.thinking === 'off') return;
    body.reasoning = { effort: this.thinking };
  }

  protected override createReasoningAccumulator(): ReasoningAccumulator {
    return reasoningAccumulator();
  }

  // Reasoning models lose the thread across a tool call unless their
  // `reasoning_details` come back verbatim, so replay the blob the
  // accumulator stashed on the thinking part.
  protected override adaptAssistantWire(
    msg: OpenAIAssistantWireMessage,
    thinking?: ThinkingPart[],
  ): OpenAIAssistantWireMessage {
    const details: ReasoningDetail[] = [];
    for (const part of thinking ?? []) {
      if (!part.redactedData) continue;
      try {
        const parsed: unknown = JSON.parse(part.redactedData);
        if (Array.isArray(parsed))
          details.push(...(parsed as ReasoningDetail[]));
      } catch {
        // A blob from some other provider (or a truncated one); the turn is
        // still valid without it, so drop it rather than failing the request.
      }
    }
    if (details.length === 0) return msg;
    return { ...msg, reasoning_details: details } as OpenAIAssistantWireMessage;
  }

  override async searchWeb(
    query: string,
    opts?: SearchOptions,
  ): Promise<SearchHit[]> {
    // The `web` plugin runs the search server-side and returns OpenAI-style
    // `url_citation` annotations alongside the synthesised answer.
    const plugin: Record<string, unknown> = { id: 'web' };
    if (opts?.maxUses !== undefined) plugin.max_results = opts.maxUses;
    if (opts?.allowedDomains) plugin.include_domains = opts.allowedDomains;
    if (opts?.blockedDomains) plugin.exclude_domains = opts.blockedDomains;

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
        ...this.extraHeaders(),
      },
      body: JSON.stringify({
        model: this.modelName,
        plugins: [plugin],
        messages: [
          {
            role: 'user',
            content: `Search the web for: ${query}. Summarise the most relevant results.`,
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(
        `OpenRouter web_search failed (${response.status}): ${await response.text()}`,
      );
    }

    const json = (await response.json()) as OpenRouterChatResponse;
    const message = json.choices?.[0]?.message;

    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    for (const annotation of message?.annotations ?? []) {
      const citation = annotation.url_citation;
      const url = citation?.url;
      if (!url || seen.has(url)) continue;
      seen.add(url);
      hits.push({
        title: citation?.title ?? url,
        url,
        ...(citation?.content ? { text: citation.content } : {}),
      });
    }

    // Some upstreams answer without emitting citations; surface the prose
    // rather than reporting an empty search, matching the OpenAI adapter.
    if (hits.length === 0) {
      const answer = message?.content?.trim();
      if (!answer) return [];
      return [{ title: 'Web search answer', text: answer }];
    }

    return opts?.maxUses !== undefined ? hits.slice(0, opts.maxUses) : hits;
  }
}

export { OpenRouter, OPENROUTER_MODELS, type OpenRouterOptions };
