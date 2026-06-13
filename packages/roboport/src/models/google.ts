import type {
  LiteralUnion,
  SearchHit,
  SearchOptions,
  ThinkingLevel,
} from '@/core';
import { env } from '@/env';

import { OpenAICompatible } from './openai-compatible';

const GEMINI_MODELS = [
  'gemini-3.5-flash',
  'gemini-3.1-pro',
  'gemini-3.1-flash-lite',
  'gemini-3-flash',
] as const;

type GeminiModelName = LiteralUnion<(typeof GEMINI_MODELS)[number]>;

interface GroundingChunk {
  web?: { uri?: string; title?: string };
}

interface GenerateContentResponse {
  candidates?: {
    groundingMetadata?: {
      groundingChunks?: GroundingChunk[];
    };
  }[];
}

class Gemini extends OpenAICompatible {
  constructor(
    modelName: GeminiModelName,
    options?: { apiKey?: string; baseUrl?: string; thinking?: ThinkingLevel },
  ) {
    const key = options?.apiKey ?? env.geminiApiKey;
    if (!key) {
      throw new Error(
        'No Gemini API key found. Set GEMINI_API_KEY or pass apiKey.',
      );
    }
    super(modelName, {
      apiKey: key,
      baseUrl:
        options?.baseUrl ??
        'https://generativelanguage.googleapis.com/v1beta/openai',
      thinking: options?.thinking,
    });
  }

  // Gemini's OpenAI compatibility shim maps `reasoning_effort` onto its own
  // `thinking_level` parameter, but only accepts `low | medium | high`. Collapse
  // the six unified levels onto that range; for direct `thinking_budget`
  // control, callers can hit the native API.
  protected override applyThinking(body: Record<string, unknown>): void {
    if (this.thinking === 'off') return;
    const effort =
      this.thinking === 'minimal' || this.thinking === 'low'
        ? 'low'
        : this.thinking === 'medium'
          ? 'medium'
          : 'high';
    body.reasoning_effort = effort;
  }

  override async searchWeb(
    query: string,
    opts?: SearchOptions,
  ): Promise<SearchHit[]> {
    // The OpenAI-compatible shim does not expose the google_search builtin,
    // so call the native generateContent endpoint instead.
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.modelName}:generateContent`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': this.apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: query }] }],
        tools: [{ google_search: {} }],
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Gemini web_search failed (${response.status}): ${await response.text()}`,
      );
    }

    const json = (await response.json()) as GenerateContentResponse;
    const chunks = json.candidates?.[0]?.groundingMetadata?.groundingChunks;
    if (!Array.isArray(chunks)) return [];

    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    for (const chunk of chunks) {
      const uri = chunk.web?.uri;
      if (!uri || seen.has(uri)) continue;
      seen.add(uri);
      hits.push({ title: chunk.web?.title ?? uri, url: uri });
    }

    if (opts?.maxUses !== undefined) return hits.slice(0, opts.maxUses);
    return hits;
  }
}

export { Gemini, GEMINI_MODELS };
