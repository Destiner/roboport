import type { SearchHit, SearchOptions } from '@/core';

import { OpenAICompatibleModel } from './openai-compatible';

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

class GeminiModel extends OpenAICompatibleModel {
  constructor(
    modelName: string,
    options?: { apiKey?: string; baseUrl?: string },
  ) {
    const key = options?.apiKey ?? process.env.GEMINI_API_KEY;
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
    });
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

// eslint-disable-next-line import-x/prefer-default-export
export { GeminiModel };
