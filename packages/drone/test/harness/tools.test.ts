import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import type { ToolContext } from '@/core';
import { webFetch, webSearch } from '@/harness/tools';

describe('webSearch tool', () => {
  test('is a non-deferred web_search tool', () => {
    expect(webSearch.name).toBe('web_search');
    expect(webSearch.deferred).toBeFalsy();
  });

  test('delegates to ctx.searchWeb with mapped domain filters', async () => {
    const calls: { query: string; opts: unknown }[] = [];
    const ctx = {
      searchWeb: (query: string, opts?: unknown) => {
        calls.push({ query, opts });
        return Promise.resolve([]);
      },
    } as unknown as ToolContext;

    const input = webSearch.parse({
      query: 'hello',
      allowed_domains: ['a.com'],
      blocked_domains: ['b.com'],
    });
    await webSearch.execute(input, ctx);

    expect(calls[0]).toEqual({
      query: 'hello',
      opts: { allowedDomains: ['a.com'], blockedDomains: ['b.com'] },
    });
  });
});

describe('webFetch tool', () => {
  afterEach(() => {
    spyOn(globalThis, 'fetch').mockRestore();
  });

  test('is a non-deferred web_fetch tool', () => {
    expect(webFetch.name).toBe('web_fetch');
    expect(webFetch.deferred).toBeFalsy();
  });

  test('fetches, strips markup, and runs the prompt via ctx.complete', async () => {
    spyOn(globalThis, 'fetch').mockImplementation(
      (async () =>
        new Response(
          '<html><body><script>ignore()</script><p>Hello <b>world</b></p></body></html>',
          { status: 200 },
        )) as never,
    );

    let seen = '';
    const ctx = {
      complete: (prompt: string) => {
        seen = prompt;
        return Promise.resolve('answer');
      },
    } as unknown as ToolContext;

    const input = webFetch.parse({
      url: 'https://example.com',
      prompt: 'Summarize',
    });
    const out = await webFetch.execute(input, ctx);

    expect(out).toBe('answer');
    expect(seen).toContain('Summarize');
    expect(seen).toContain('Hello world');
    expect(seen).not.toContain('ignore()');
    expect(seen).not.toContain('<b>');
  });
});
