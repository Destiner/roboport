import { resolve } from 'node:path';

import { z } from 'zod';

import { Tool } from '@/core';

import {
  applyExactReplacements,
  readFile as readFileLines,
  runShell,
  runWebFetch,
  runWebSearch,
} from './shared';

// Standalone, reusable tools for apps and lean harnesses. Non-deferred so they
// work without a ToolSearch tool (e.g. under the pi harness). They share their
// bodies with the harness-bundled variants via the helpers in shared.ts. Names
// and inputs aim for a neutral middle ground between the Claude Code, Codex, and
// pi conventions; file paths resolve against ToolContext.cwd.

const webSearch = new Tool({
  name: 'web_search',
  description:
    'Search the web for current or external information beyond your knowledge. Returns relevant results (each a title, usually a URL) or a synthesized answer for direct questions.',
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

function relativePathSchema(action: 'read' | 'write' | 'edit'): z.ZodString {
  return z
    .string()
    .describe(
      `Path to the file to ${action}. Relative paths resolve against the working directory.`,
    );
}

const readFile = new Tool({
  name: 'read_file',
  description:
    'Read a file from the filesystem. Returns the content with 1-indexed line numbers. Use offset and limit to read a slice of a large file.',
  inputSchema: z.object({
    path: relativePathSchema('read'),
    offset: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('1-indexed line number to start reading from.'),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Maximum number of lines to read.'),
  }),
  execute: ({ path, offset, limit }, ctx): Promise<string> =>
    readFileLines(resolve(ctx.cwd, path), {
      offset: offset === undefined ? undefined : offset - 1,
      limit,
    }),
});

const writeFile = new Tool({
  name: 'write_file',
  description:
    'Write content to a file, creating it if missing and overwriting any existing file at the path. Prefer edit_file when changing part of an existing file.',
  inputSchema: z.object({
    path: relativePathSchema('write'),
    content: z.string().describe('The full content to write to the file.'),
  }),
  execute: async ({ path, content }, ctx): Promise<string> => {
    const filePath = resolve(ctx.cwd, path);
    await Bun.write(filePath, content);
    return `Wrote ${filePath}.`;
  },
});

const editFile = new Tool({
  name: 'edit_file',
  description:
    "Edit a file by replacing exact text. Each edit's old_text must match a unique, non-overlapping region of the file. Pass multiple edits to change several places in one call; every old_text is matched against the original file, not against earlier edits.",
  inputSchema: z.object({
    path: relativePathSchema('edit'),
    edits: z
      .array(
        z
          .object({
            old_text: z
              .string()
              .describe('Exact text to replace; must be unique in the file.'),
            new_text: z
              .string()
              .describe('Replacement text (must differ from old_text).'),
          })
          .refine((edit) => edit.old_text !== edit.new_text, {
            message: 'new_text must differ from old_text.',
          }),
      )
      .min(1)
      .describe('One or more exact-text replacements to apply.'),
  }),
  execute: async ({ path, edits }, ctx): Promise<string> => {
    const filePath = resolve(ctx.cwd, path);
    const count = await applyExactReplacements(
      filePath,
      edits.map(({ old_text, new_text }) => ({
        oldString: old_text,
        newString: new_text,
      })),
    );
    return `Edited ${filePath} (${count} replacement${count === 1 ? '' : 's'}).`;
  },
});

const bash = new Tool({
  name: 'bash',
  description:
    'Execute a shell command and return its stdout, stderr, and a non-zero exit code. Prefer the dedicated file tools over shell commands like cat, sed, or echo where they fit.',
  inputSchema: z.object({
    command: z.string().describe('The shell command to execute.'),
    timeout: z
      .number()
      .int()
      .positive()
      .max(600_000)
      .optional()
      .describe('Optional timeout in milliseconds (max 600000).'),
    workdir: z
      .string()
      .optional()
      .describe(
        'Directory to run the command in. Defaults to the working directory.',
      ),
  }),
  execute: ({ command, timeout, workdir }, ctx): Promise<string> =>
    runShell({
      cmd: command,
      timeout,
      workdir: workdir ? resolve(ctx.cwd, workdir) : ctx.cwd,
    }),
});

export { bash, editFile, readFile, webFetch, webSearch, writeFile };
