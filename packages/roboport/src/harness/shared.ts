import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { z } from 'zod';

import { Tool, type SearchHit, type ToolContext } from '@/core';

function notImplemented(name: string): () => Promise<never> {
  return async (): Promise<never> => {
    throw new Error(`Tool "${name}" is not implemented.`);
  };
}

// Shared web-search implementation: maps the conventional tool args to the
// model's native search (ctx.searchWeb). Each harness/app declares its own tool
// (name, schema, description) and delegates the body here.
function runWebSearch(
  ctx: ToolContext,
  args: {
    query: string;
    allowed_domains?: string[];
    blocked_domains?: string[];
  },
): Promise<SearchHit[]> {
  return ctx.searchWeb(args.query, {
    allowedDomains: args.allowed_domains,
    blockedDomains: args.blocked_domains,
  });
}

// Shared web-fetch implementation: fetch a URL, strip markup, and run the
// caller's prompt over the content via the model. Each harness/app declares its
// own tool and delegates here.
async function runWebFetch(
  ctx: ToolContext,
  args: { url: string; prompt: string },
): Promise<string> {
  const response = await fetch(args.url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${args.url}: ${response.status}`);
  }
  const body = await response.text();
  const cleaned = body
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return ctx.complete(
    `${args.prompt}\n\n---\n\nContent from ${args.url}:\n\n${cleaned}`,
  );
}

function serializeShellResult(
  stdout: string,
  stderr: string,
  exitCode: number,
): string {
  const parts: string[] = [];
  if (stdout) parts.push(stdout.trimEnd());
  if (stderr) parts.push(`stderr:\n${stderr.trimEnd()}`);
  if (exitCode !== 0) parts.push(`Exit code: ${exitCode}`);
  return parts.join('\n\n');
}

async function runShell({
  cmd,
  timeout,
  workdir,
  shell,
  login,
}: {
  cmd: string;
  timeout?: number;
  workdir?: string;
  shell?: string;
  login?: boolean;
}): Promise<string> {
  const shellPath = shell ?? 'bash';
  // Pass env explicitly: Bun seeds child env from a startup snapshot and does
  // not reflect later process.env mutations, which callers rely on for tokens
  // set at runtime (e.g. a refreshed GH_TOKEN).
  const proc = Bun.spawn([shellPath, login === false ? '-c' : '-lc', cmd], {
    cwd: workdir,
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  });
  const timer = setTimeout(() => proc.kill(), timeout ?? 120_000);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(timer);

  return serializeShellResult(stdout, stderr, exitCode);
}

async function readFile(
  filePath: string,
  opts?: { offset?: number; limit?: number },
): Promise<string> {
  const content = await Bun.file(filePath).text();
  const lines = content.split('\n');
  const start = opts?.offset ?? 0;
  const end = opts?.limit !== undefined ? start + opts.limit : lines.length;
  const slice = lines.slice(start, end);
  return slice
    .map((line, i) => `${(start + i + 1).toString().padStart(6, ' ')}\t${line}`)
    .join('\n');
}

type ExactReplacement = {
  oldString: string;
  newString: string;
};

async function applyExactReplacements(
  filePath: string,
  replacements: ExactReplacement[],
): Promise<number> {
  const content = await Bun.file(filePath).text();
  const ranges = replacements.map(({ oldString, newString }) => {
    const start = content.indexOf(oldString);
    if (start === -1) {
      throw new Error(`String not found in ${filePath}.`);
    }
    if (content.indexOf(oldString, start + oldString.length) !== -1) {
      throw new Error(
        `String is not unique in ${filePath}. Provide more context.`,
      );
    }
    return { start, end: start + oldString.length, newString };
  });

  ranges.sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i += 1) {
    const previous = ranges[i - 1];
    const current = ranges[i];
    if (!previous || !current) continue;
    if (current.start < previous.end) {
      throw new Error(`Replacement ranges overlap in ${filePath}.`);
    }
  }

  let updated = '';
  let cursor = 0;
  for (const range of ranges) {
    updated += content.slice(cursor, range.start);
    updated += range.newString;
    cursor = range.end;
  }
  updated += content.slice(cursor);

  await Bun.write(filePath, updated);
  return ranges.length;
}

function consumePrefixedLine(
  lines: string[],
  index: number,
  prefix: string,
): string | undefined {
  const line = lines[index];
  if (line === undefined || !line.startsWith(prefix)) return undefined;
  return line.slice(prefix.length);
}

async function applyPatchText(
  patch: string,
  opts?: { cwd?: string },
): Promise<string> {
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines[0] !== '*** Begin Patch') {
    throw new Error('Patch must start with "*** Begin Patch".');
  }
  if (lines.at(-1) !== '*** End Patch') {
    throw new Error('Patch must end with "*** End Patch".');
  }

  const cwd = opts?.cwd;
  function r(p: string): string {
    return cwd ? resolve(cwd, p) : p;
  }

  const changed: string[] = [];
  let index = 1;
  while (index < lines.length - 1) {
    const addFile = consumePrefixedLine(lines, index, '*** Add File: ');
    if (addFile !== undefined) {
      index += 1;
      const content: string[] = [];
      while (index < lines.length - 1 && !lines[index]?.startsWith('*** ')) {
        const line = consumePrefixedLine(lines, index, '+');
        if (line === undefined) {
          throw new Error(`Invalid add-file line at ${index + 1}.`);
        }
        content.push(line);
        index += 1;
      }
      const target = r(addFile);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, `${content.join('\n')}\n`);
      changed.push(`added ${addFile}`);
      continue;
    }

    const deleteFile = consumePrefixedLine(lines, index, '*** Delete File: ');
    if (deleteFile !== undefined) {
      await rm(r(deleteFile));
      changed.push(`deleted ${deleteFile}`);
      index += 1;
      continue;
    }

    const updateFile = consumePrefixedLine(lines, index, '*** Update File: ');
    if (updateFile === undefined) {
      throw new Error(`Invalid patch header at ${index + 1}.`);
    }
    index += 1;

    const moveTo = consumePrefixedLine(lines, index, '*** Move to: ');
    if (moveTo !== undefined) index += 1;

    const updatePath = r(updateFile);
    let content = await Bun.file(updatePath).text();
    while (index < lines.length - 1 && lines[index]?.startsWith('@@')) {
      index += 1;
      const oldLines: string[] = [];
      const newLines: string[] = [];
      while (index < lines.length - 1 && !lines[index]?.startsWith('@@')) {
        const line = lines[index];
        if (line === undefined || line.startsWith('*** ')) break;
        const marker = line[0];
        const value = line.slice(1);
        if (marker === ' ') {
          oldLines.push(value);
          newLines.push(value);
        } else if (marker === '-') {
          oldLines.push(value);
        } else if (marker === '+') {
          newLines.push(value);
        } else {
          throw new Error(`Invalid hunk line at ${index + 1}.`);
        }
        index += 1;
      }

      const oldText = oldLines.join('\n');
      const newText = newLines.join('\n');
      const first = content.indexOf(oldText);
      if (first === -1) {
        throw new Error(`Patch hunk not found in ${updateFile}.`);
      }
      if (content.indexOf(oldText, first + oldText.length) !== -1) {
        throw new Error(`Patch hunk is not unique in ${updateFile}.`);
      }
      content =
        content.slice(0, first) +
        newText +
        content.slice(first + oldText.length);
    }

    const targetLabel = moveTo ?? updateFile;
    const targetPath = moveTo !== undefined ? r(moveTo) : updatePath;
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content);
    if (moveTo !== undefined) await rm(updatePath);
    changed.push(
      moveTo === undefined
        ? `updated ${targetLabel}`
        : `moved ${updateFile} to ${targetLabel}`,
    );
  }

  return changed.join('\n');
}

function createToolSearch(): Tool {
  return new Tool({
    name: 'ToolSearch',
    description:
      'Fetches full schema definitions for deferred tools so they can be called. Use query "select:<name>[,<name>...]" for direct selection, or keywords to search by name/description.',
    inputSchema: z.object({
      query: z
        .string()
        .describe(
          'Query to find deferred tools. Use "select:<tool_name>" for direct selection, or keywords to search.',
        ),
      max_results: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Maximum number of results to return (default: 5).'),
    }),
    execute: ({ query, max_results }, ctx): string => {
      const max = max_results ?? 5;
      const deferred = ctx.tools.deferred();

      let names: string[];
      if (query.startsWith('select:')) {
        names = query
          .slice('select:'.length)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      } else {
        const terms = query
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean)
          .map((t) => (t.startsWith('+') ? t.slice(1) : t));
        const scored = deferred
          .map((tool) => {
            const haystack = `${tool.name} ${tool.description}`.toLowerCase();
            const score = terms.reduce(
              (acc, term) => acc + (haystack.includes(term) ? 1 : 0),
              0,
            );
            return { tool, score };
          })
          .filter(({ score }) => score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, max);
        names = scored.map(({ tool }) => tool.name);
      }

      const { loaded, missing } = ctx.tools.load(names);

      const lines = loaded.map((tool) => {
        const parameters = tool.toJsonSchema();
        return `<function>${JSON.stringify({
          description: tool.description,
          name: tool.name,
          parameters,
        })}</function>`;
      });

      const parts = [`<functions>\n${lines.join('\n')}\n</functions>`];
      if (missing.length > 0) {
        parts.push(`Not found: ${missing.join(', ')}`);
      }
      return parts.join('\n\n');
    },
  });
}

export {
  applyExactReplacements,
  applyPatchText,
  createToolSearch,
  notImplemented,
  readFile,
  runShell,
  runWebFetch,
  runWebSearch,
  serializeShellResult,
};
