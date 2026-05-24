import type { LiteralUnion, SearchHit, SearchOptions } from '@/core';

import { OpenAICompatibleModel } from './openai-compatible';

const OPENAI_MODELS = [
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
  'gpt-5.3-codex',
] as const;

type OpenAIModelName = LiteralUnion<(typeof OPENAI_MODELS)[number]>;

class OpenAIModel extends OpenAICompatibleModel {
  constructor(
    modelName: OpenAIModelName,
    options?: { apiKey?: string; baseUrl?: string },
  ) {
    const key = options?.apiKey ?? process.env.OPENAI_API_KEY;
    if (!key) {
      throw new Error(
        'No OpenAI API key found. Set OPENAI_API_KEY or pass apiKey.',
      );
    }
    super(modelName, {
      apiKey: key,
      baseUrl: options?.baseUrl ?? 'https://api.openai.com/v1',
    });
  }

  override async searchWeb(
    query: string,
    opts?: SearchOptions,
  ): Promise<SearchHit[]> {
    const response = await fetch(`${this.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.modelName,
        tools: [{ type: 'web_search_preview' }],
        input: `Search the web for: ${query}`,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `OpenAI web_search failed (${response.status}): ${await response.text()}`,
      );
    }

    const json = (await response.json()) as {
      output: ({ type: string } & Record<string, unknown>)[];
    };

    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    for (const item of json.output) {
      if (item.type !== 'message') continue;
      const parts = item.content as
        | ({ type: string } & Record<string, unknown>)[]
        | undefined;
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        const annotations = part.annotations as
          | { type: string; url?: string; title?: string }[]
          | undefined;
        if (!Array.isArray(annotations)) continue;
        for (const ann of annotations) {
          if (ann.type !== 'url_citation') continue;
          if (!ann.url || seen.has(ann.url)) continue;
          seen.add(ann.url);
          hits.push({ title: ann.title ?? ann.url, url: ann.url });
        }
      }
    }

    if (opts?.maxUses !== undefined) return hits.slice(0, opts.maxUses);
    return hits;
  }
}

export { OpenAIModel, OPENAI_MODELS };
