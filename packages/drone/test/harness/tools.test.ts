import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ToolContext } from '@/core';
import {
  bash,
  editFile,
  readFile,
  webFetch,
  webSearch,
  writeFile,
} from '@/harness/tools';

describe('webSearch tool', () => {
  test('is a non-deferred web_search tool', () => {
    expect(webSearch.name).toBe('web_search');
    expect(webSearch.deferred).toBeFalsy();
  });

  test('delegates to ctx.searchWeb with mapped domain filters', async () => {
    let captured: { query: string; opts: unknown } | undefined;
    const ctx = {
      searchWeb: (query: string, opts?: unknown) => {
        captured = { query, opts };
        return Promise.resolve([]);
      },
    } as unknown as ToolContext;

    const input = webSearch.parse({
      query: 'hello',
      allowed_domains: ['a.com'],
      blocked_domains: ['b.com'],
    });
    await webSearch.execute(input, ctx);

    expect(captured).toEqual({
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

describe('filesystem and shell tools', () => {
  let workdir: string;

  beforeEach(async (): Promise<void> => {
    workdir = await mkdtemp(join(tmpdir(), 'drone-tools-'));
  });

  afterEach(async (): Promise<void> => {
    await rm(workdir, { recursive: true, force: true });
  });

  function makeCtx(): ToolContext {
    return { cwd: workdir } as unknown as ToolContext;
  }

  test('read_file resolves relative paths and uses 1-indexed offset', async (): Promise<void> => {
    await Bun.write(join(workdir, 'note.txt'), 'a\nb\nc\nd');
    const ctx = makeCtx();

    const input = readFile.parse({ path: 'note.txt', offset: 2, limit: 2 });
    const out = (await readFile.execute(input, ctx)) as string;

    expect(out).toBe('     2\tb\n     3\tc');
  });

  test('write_file writes relative to the working directory', async (): Promise<void> => {
    const ctx = makeCtx();

    const input = writeFile.parse({ path: 'out.txt', content: 'hello' });
    const out = (await writeFile.execute(input, ctx)) as string;

    expect(out).toContain(join(workdir, 'out.txt'));
    expect(await Bun.file(join(workdir, 'out.txt')).text()).toBe('hello');
  });

  test('edit_file applies multiple exact replacements', async (): Promise<void> => {
    await Bun.write(join(workdir, 'src.txt'), 'foo bar baz');
    const ctx = makeCtx();

    const input = editFile.parse({
      path: 'src.txt',
      edits: [
        { old_text: 'foo', new_text: 'FOO' },
        { old_text: 'baz', new_text: 'qux' },
      ],
    });
    const out = (await editFile.execute(input, ctx)) as string;

    expect(out).toContain('2 replacements');
    expect(await Bun.file(join(workdir, 'src.txt')).text()).toBe('FOO bar qux');
  });

  test('edit_file rejects a no-op replacement', (): void => {
    expect(() =>
      editFile.parse({
        path: 'src.txt',
        edits: [{ old_text: 'foo', new_text: 'foo' }],
      }),
    ).toThrow(/must differ/);
  });

  test('bash runs the command in the working directory', async (): Promise<void> => {
    await Bun.write(join(workdir, 'marker.txt'), 'inside-workdir');
    const ctx = makeCtx();

    const input = bash.parse({ command: 'cat marker.txt' });
    const out = (await bash.execute(input, ctx)) as string;

    expect(out).toBe('inside-workdir');
  });
});
