import type { SearchHit } from '@/core';

interface AnthropicSearchOptions {
  apiKey?: string;
  model?: string;
  maxUses?: number;
}

interface SearchProviderOptions {
  allowed_domains?: string[];
  blocked_domains?: string[];
}

interface SearchProvider {
  search(query: string, opts?: SearchProviderOptions): Promise<SearchHit[]>;
}

interface WebSearchResult {
  type: 'web_search_result';
  url: string;
  title: string;
  page_age?: string | null;
  encrypted_content?: string;
}

interface WebSearchToolResult {
  type: 'web_search_tool_result';
  tool_use_id: string;
  content:
    | WebSearchResult[]
    | { type: 'web_search_tool_result_error'; error_code: string };
}

interface AnthropicMessageResponse {
  content: ({ type: string } & Record<string, unknown>)[];
}

function anthropicSearch(options: AnthropicSearchOptions = {}): SearchProvider {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'No Anthropic API key found. Set ANTHROPIC_API_KEY or pass apiKey.',
    );
  }
  const model = options.model ?? 'claude-haiku-4-5-20251001';

  return {
    search: async (query, opts): Promise<SearchHit[]> => {
      const tool: Record<string, unknown> = {
        type: 'web_search_20250305',
        name: 'web_search',
      };
      if (opts?.allowed_domains) tool.allowed_domains = opts.allowed_domains;
      if (opts?.blocked_domains) tool.blocked_domains = opts.blocked_domains;
      if (options.maxUses !== undefined) tool.max_uses = options.maxUses;

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          tools: [tool],
          messages: [
            {
              role: 'user',
              content: `Search the web for: ${query}`,
            },
          ],
        }),
      });

      if (!response.ok) {
        throw new Error(
          `Anthropic web_search failed (${response.status}): ${await response.text()}`,
        );
      }

      const json = (await response.json()) as AnthropicMessageResponse;

      const hits: SearchHit[] = [];
      for (const block of json.content) {
        if (block.type !== 'web_search_tool_result') continue;
        const result = block as unknown as WebSearchToolResult;
        if (!Array.isArray(result.content)) continue;
        for (const item of result.content) {
          if (item.type !== 'web_search_result') continue;
          hits.push({
            title: item.title,
            url: item.url,
            pageAge: item.page_age ?? undefined,
          });
        }
      }
      return hits;
    },
  };
}

export { anthropicSearch, type AnthropicSearchOptions };
