import { z } from 'zod';

import { Tool } from '@/core';

import { runWebFetch, runWebSearch } from './shared';

// Standalone, reusable tools for apps and lean harnesses. Non-deferred so they
// work without a ToolSearch tool (e.g. under the pi harness). They share their
// bodies with the harness-bundled variants via the run* helpers in shared.ts.

const webSearch = new Tool({
  name: 'web_search',
  description:
    'Search the web for current or external information beyond your knowledge. Returns results with titles and URLs.',
  inputSchema: z.object({
    query: z.string().min(2).describe('The search query to use.'),
    allowed_domains: z
      .array(z.string())
      .optional()
      .describe('Only include search results from these domains.'),
    blocked_domains: z
      .array(z.string())
      .optional()
      .describe('Never include search results from these domains.'),
  }),
  execute: (args, ctx): ReturnType<typeof runWebSearch> =>
    runWebSearch(ctx, args),
});

const webFetch = new Tool({
  name: 'web_fetch',
  description:
    'Fetch a URL and extract or answer something from its content. Use after web_search to read a result, or when given a URL directly.',
  inputSchema: z.object({
    url: z.url().describe('The URL to fetch.'),
    prompt: z
      .string()
      .describe('What to extract from or answer about the page content.'),
  }),
  execute: (args, ctx): ReturnType<typeof runWebFetch> =>
    runWebFetch(ctx, args),
});

export { webSearch, webFetch };
