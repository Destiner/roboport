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
