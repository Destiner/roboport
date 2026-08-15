import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Tool, ToolContext } from '@/core';
import harness from '@/harness/claudeCode';

function tool(name: string): Tool {
  const found = harness.tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

describe('claudeCode Glob tool', () => {
  let workdir: string;

  beforeEach(async (): Promise<void> => {
    workdir = await mkdtemp(join(tmpdir(), 'roboport-glob-'));
    await mkdir(join(workdir, 'src'), { recursive: true });
    await writeFile(join(workdir, 'src', 'a.ts'), 'a');
    await writeFile(join(workdir, 'src', 'b.ts'), 'b');
    await writeFile(join(workdir, 'README.md'), 'readme');
  });

  afterEach(async (): Promise<void> => {
    await rm(workdir, { recursive: true, force: true });
  });

  function run(pattern: string): Promise<string> {
    const glob = tool('Glob');
    const ctx = { cwd: workdir } as unknown as ToolContext;
    return glob.execute(glob.parse({ pattern }), ctx) as Promise<string>;
  }

  test('matches nested files by pattern', async (): Promise<void> => {
    const lines = (await run('**/*.ts')).split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines).toContain(join(workdir, 'src', 'a.ts'));
    expect(lines).toContain(join(workdir, 'src', 'b.ts'));
  });

  test('excludes directories from matches', async (): Promise<void> => {
    const lines = (await run('*')).split('\n').filter(Boolean);
    expect(lines).toContain(join(workdir, 'README.md'));
    expect(lines).not.toContain(join(workdir, 'src'));
  });
});

describe('claudeCode file tools resolve paths against the session cwd', () => {
  let workdir: string;

  beforeEach(async (): Promise<void> => {
    workdir = await mkdtemp(join(tmpdir(), 'roboport-files-'));
  });

  afterEach(async (): Promise<void> => {
    await rm(workdir, { recursive: true, force: true });
  });

  function run(name: string, args: Record<string, unknown>): Promise<string> {
    const t = tool(name);
    const ctx = { cwd: workdir } as unknown as ToolContext;
    return t.execute(t.parse(args), ctx) as Promise<string>;
  }

  // A relative file_path used to resolve against process.cwd(), so a model that
  // sent "./note.txt" wrote outside the directory the session was scoped to.
  test('Write places a relative path inside the cwd, not process.cwd()', async (): Promise<void> => {
    await run('Write', { file_path: './note.txt', content: 'scoped' });
    expect(await Bun.file(join(workdir, 'note.txt')).text()).toBe('scoped');
  });

  test('Write still honours an absolute path', async (): Promise<void> => {
    const target = join(workdir, 'nested', 'abs.txt');
    await run('Write', { file_path: target, content: 'absolute' });
    expect(await Bun.file(target).text()).toBe('absolute');
  });

  test('Read resolves a relative path against the cwd', async (): Promise<void> => {
    await writeFile(join(workdir, 'read.txt'), 'hello');
    expect(await run('Read', { file_path: './read.txt' })).toContain('hello');
  });

  test('Edit resolves a relative path against the cwd', async (): Promise<void> => {
    await writeFile(join(workdir, 'edit.txt'), 'before');
    await run('Edit', {
      file_path: 'edit.txt',
      old_string: 'before',
      new_string: 'after',
    });
    expect(await Bun.file(join(workdir, 'edit.txt')).text()).toBe('after');
  });

  test('Edit resolves a relative path when replacing all', async (): Promise<void> => {
    await writeFile(join(workdir, 'all.txt'), 'x x x');
    await run('Edit', {
      file_path: 'all.txt',
      old_string: 'x',
      new_string: 'y',
      replace_all: true,
    });
    expect(await Bun.file(join(workdir, 'all.txt')).text()).toBe('y y y');
  });
});
