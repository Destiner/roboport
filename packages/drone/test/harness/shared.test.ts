import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile as fsReadFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import { Tool, createRegistry, type ToolContext } from '@/core/tool';
import {
  applyExactReplacements,
  applyPatchText,
  createToolSearch,
  notImplemented,
  readFile,
  runShell,
  serializeShellResult,
} from '@/harness/shared';

let workdir: string;

beforeEach(async (): Promise<void> => {
  workdir = await mkdtemp(join(tmpdir(), 'drone-shared-'));
});

afterEach(async (): Promise<void> => {
  await rm(workdir, { recursive: true, force: true });
});

function makeCtx(tools: Tool[]): ToolContext {
  return {
    complete: async (): Promise<string> => {
      throw new Error('not used');
    },
    searchWeb: async (): Promise<never> => {
      throw new Error('not used');
    },
    session: { messages: [], store: new Map() },
    tools: createRegistry(tools),
    cwd: process.cwd(),
  };
}

describe('notImplemented', () => {
  test('returns a function that rejects with the tool name', async (): Promise<void> => {
    const fn = notImplemented('FooTool');
    await expect(fn()).rejects.toThrow('Tool "FooTool" is not implemented.');
  });
});

describe('serializeShellResult', () => {
  test('returns trimmed stdout on success', (): void => {
    expect(serializeShellResult('hello\n', '', 0)).toBe('hello');
  });

  test('prefixes stderr block when stderr present', (): void => {
    expect(serializeShellResult('', 'err\n', 0)).toBe('stderr:\nerr');
  });

  test('appends exit code when non-zero', (): void => {
    expect(serializeShellResult('', '', 1)).toBe('Exit code: 1');
  });

  test('combines all parts separated by blank lines', (): void => {
    expect(serializeShellResult('out\n', 'err\n', 2)).toBe(
      'out\n\nstderr:\nerr\n\nExit code: 2',
    );
  });

  test('returns empty string when nothing to report', (): void => {
    expect(serializeShellResult('', '', 0)).toBe('');
  });
});

describe('runShell', () => {
  test('captures stdout from a successful command', async (): Promise<void> => {
    const result = await runShell({ cmd: 'echo hello', login: false });
    expect(result).toBe('hello');
  });

  test('captures stderr and exit code on failure', async (): Promise<void> => {
    const result = await runShell({
      cmd: 'echo boom 1>&2; exit 3',
      login: false,
    });
    expect(result).toContain('stderr:\nboom');
    expect(result).toContain('Exit code: 3');
  });

  test('honours workdir', async (): Promise<void> => {
    const result = await runShell({ cmd: 'pwd', workdir, login: false });
    expect(result).toContain(workdir);
  });
});

describe('readFile', () => {
  test('formats every line with a 1-indexed padded prefix', async (): Promise<void> => {
    const filePath = join(workdir, 'note.txt');
    await Bun.write(filePath, 'alpha\nbeta\ngamma');
    const output = await readFile(filePath);
    expect(output).toBe('     1\talpha\n     2\tbeta\n     3\tgamma');
  });

  test('applies offset and limit', async (): Promise<void> => {
    const filePath = join(workdir, 'note.txt');
    await Bun.write(filePath, 'a\nb\nc\nd\ne');
    const output = await readFile(filePath, { offset: 1, limit: 2 });
    expect(output).toBe('     2\tb\n     3\tc');
  });
});

describe('applyExactReplacements', () => {
  test('replaces a unique substring', async (): Promise<void> => {
    const filePath = join(workdir, 'src.txt');
    await Bun.write(filePath, 'hello world');
    const count = await applyExactReplacements(filePath, [
      { oldString: 'world', newString: 'drone' },
    ]);
    expect(count).toBe(1);
    expect(await Bun.file(filePath).text()).toBe('hello drone');
  });

  test('replaces multiple non-overlapping ranges', async (): Promise<void> => {
    const filePath = join(workdir, 'src.txt');
    await Bun.write(filePath, 'foo bar baz');
    const count = await applyExactReplacements(filePath, [
      { oldString: 'baz', newString: 'qux' },
      { oldString: 'foo', newString: 'FOO' },
    ]);
    expect(count).toBe(2);
    expect(await Bun.file(filePath).text()).toBe('FOO bar qux');
  });

  test('throws when the string is not found', async (): Promise<void> => {
    const filePath = join(workdir, 'src.txt');
    await Bun.write(filePath, 'hello');
    await expect(
      applyExactReplacements(filePath, [
        { oldString: 'world', newString: 'drone' },
      ]),
    ).rejects.toThrow(/String not found/);
  });

  test('throws when the string occurs more than once', async (): Promise<void> => {
    const filePath = join(workdir, 'src.txt');
    await Bun.write(filePath, 'a a');
    await expect(
      applyExactReplacements(filePath, [{ oldString: 'a', newString: 'b' }]),
    ).rejects.toThrow(/not unique/);
  });

  test('throws when replacement ranges overlap', async (): Promise<void> => {
    const filePath = join(workdir, 'src.txt');
    await Bun.write(filePath, 'abcdef');
    await expect(
      applyExactReplacements(filePath, [
        { oldString: 'abc', newString: 'X' },
        { oldString: 'cde', newString: 'Y' },
      ]),
    ).rejects.toThrow(/overlap/);
  });
});

describe('applyPatchText', () => {
  test('rejects a patch without the required envelope', async (): Promise<void> => {
    await expect(applyPatchText('nope')).rejects.toThrow(/Begin Patch/);
  });

  test('adds a new file', async (): Promise<void> => {
    const target = join(workdir, 'added.txt');
    const patch = [
      '*** Begin Patch',
      `*** Add File: ${target}`,
      '+line one',
      '+line two',
      '*** End Patch',
    ].join('\n');
    const summary = await applyPatchText(patch);
    expect(summary).toBe(`added ${target}`);
    expect(await Bun.file(target).text()).toBe('line one\nline two\n');
  });

  test('updates an existing file via a hunk', async (): Promise<void> => {
    const target = join(workdir, 'update.txt');
    await Bun.write(target, 'alpha\nbeta\ngamma\n');
    const patch = [
      '*** Begin Patch',
      `*** Update File: ${target}`,
      '@@',
      ' alpha',
      '-beta',
      '+BETA',
      ' gamma',
      '*** End Patch',
    ].join('\n');
    const summary = await applyPatchText(patch);
    expect(summary).toBe(`updated ${target}`);
    expect(await Bun.file(target).text()).toBe('alpha\nBETA\ngamma\n');
  });

  test('deletes a file', async (): Promise<void> => {
    const target = join(workdir, 'gone.txt');
    await Bun.write(target, 'bye');
    const patch = [
      '*** Begin Patch',
      `*** Delete File: ${target}`,
      '*** End Patch',
    ].join('\n');
    const summary = await applyPatchText(patch);
    expect(summary).toBe(`deleted ${target}`);
    await expect(fsReadFile(target, 'utf8')).rejects.toThrow();
  });
});

describe('createToolSearch', () => {
  test('exposes a Zod-typed schema', (): void => {
    const search = createToolSearch();
    expect(search.name).toBe('ToolSearch');
    const schema = search.toJsonSchema() as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.properties).toHaveProperty('query');
    expect(schema.properties).toHaveProperty('max_results');
    expect(schema.required).toEqual(['query']);
  });

  test('loads tools by name when query uses select:', async (): Promise<void> => {
    const deferred = new Tool({
      name: 'Hidden',
      description: 'a hidden tool',
      inputSchema: z.object({ value: z.string() }),
      execute: (): string => 'ok',
      deferred: true,
    });
    const search = createToolSearch();
    const ctx = makeCtx([search, deferred]);
    const out = (await search.execute(
      { query: 'select:Hidden' },
      ctx,
    )) as string;
    expect(out).toContain('<functions>');
    expect(out).toContain('"name":"Hidden"');
    expect(out).toContain('"description":"a hidden tool"');
    expect(ctx.tools.loaded().some((t) => t.name === 'Hidden')).toBe(true);
  });

  test('reports missing tools when select: cannot resolve names', async (): Promise<void> => {
    const search = createToolSearch();
    const ctx = makeCtx([search]);
    const out = (await search.execute(
      { query: 'select:Ghost' },
      ctx,
    )) as string;
    expect(out).toContain('Not found: Ghost');
  });

  test('keyword search ranks deferred tools by term hits', async (): Promise<void> => {
    const alpha = new Tool({
      name: 'AlphaTool',
      description: 'manages alpha things',
      inputSchema: z.object({}),
      execute: (): string => 'a',
      deferred: true,
    });
    const beta = new Tool({
      name: 'BetaTool',
      description: 'unrelated helper',
      inputSchema: z.object({}),
      execute: (): string => 'b',
      deferred: true,
    });
    const search = createToolSearch();
    const ctx = makeCtx([search, alpha, beta]);
    const out = (await search.execute({ query: 'alpha' }, ctx)) as string;
    expect(out).toContain('"name":"AlphaTool"');
    expect(out).not.toContain('"name":"BetaTool"');
  });
});
