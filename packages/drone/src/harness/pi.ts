import { resolve } from 'node:path';

import { z } from 'zod';

import { Tool } from '@/core';

import { Harness } from './core';
import { applyExactReplacements, readFile, runShell } from './shared';

const read = new Tool({
  name: 'read',
  description:
    'Read the contents of a file. Supports text files and uses offset/limit for large files. When you need the full file, continue with offset until complete.',
  inputSchema: z.object({
    path: z
      .string()
      .describe('Path to the file to read (relative or absolute)'),
    offset: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Line number to start reading from (1-indexed)'),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Maximum number of lines to read'),
  }),
  execute: ({ path, offset, limit }): Promise<string> =>
    readFile(resolve(path), {
      offset: offset === undefined ? undefined : offset - 1,
      limit,
    }),
});

const write = new Tool({
  name: 'write',
  description:
    "Write content to a file. Creates the file if it doesn't exist, overwrites if it does.",
  inputSchema: z.object({
    path: z
      .string()
      .describe('Path to the file to write (relative or absolute)'),
    content: z.string().describe('Content to write to the file'),
  }),
  execute: async ({ path, content }): Promise<string> => {
    const filePath = resolve(path);
    await Bun.write(filePath, content);
    return `Wrote ${filePath}.`;
  },
});

const editSchema = z.object({
  oldText: z.string().describe('Exact text for one targeted replacement.'),
  newText: z.string().describe('Replacement text for this targeted edit.'),
});

const edit = new Tool({
  name: 'edit',
  description:
    'Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits.',
  inputSchema: z.object({
    path: z
      .string()
      .describe('Path to the file to edit (relative or absolute)'),
    edits: z
      .array(editSchema)
      .min(1)
      .describe(
        'One or more targeted replacements. Each edit is matched against the original file, not incrementally.',
      ),
  }),
  execute: async ({ path, edits }): Promise<string> => {
    const filePath = resolve(path);
    const count = await applyExactReplacements(
      filePath,
      edits.map(({ oldText, newText }) => ({
        oldString: oldText,
        newString: newText,
      })),
    );
    return `Successfully replaced ${count} block(s) in ${path}.`;
  },
});

const bash = new Tool({
  name: 'bash',
  description:
    'Execute a bash command in the current working directory. Returns stdout, stderr, and exit code when non-zero. Optionally provide a timeout in seconds.',
  inputSchema: z.object({
    command: z.string().describe('Bash command to execute'),
    timeout: z
      .number()
      .positive()
      .optional()
      .describe('Timeout in seconds (optional, no default timeout)'),
  }),
  execute: ({ command, timeout }): Promise<string> =>
    runShell({
      cmd: command,
      timeout: timeout === undefined ? undefined : timeout * 1000,
    }),
});

const system = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
- read: Read file contents
- bash: Execute bash commands (ls, grep, find, etc.)
- edit: Make precise file edits with exact text replacement, including multiple disjoint edits in one call
- write: Create or overwrite files

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
- Use bash for file operations like ls, rg, find
- Use read to examine files instead of cat or sed.
- Use edit for precise changes (edits[].oldText must match exactly)
- When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls
- Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.
- Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.
- Use write only for new files or complete rewrites.
- Be concise in your responses
- Show file paths clearly when working with files`;

const tools: Tool[] = [read, bash, edit, write];

const harness = new Harness(system, tools);

export default harness;
