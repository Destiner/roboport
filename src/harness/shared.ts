import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { z } from 'zod';

import { Tool, type SearchHit, type ToolContext } from '@/core';

function notImplemented(name: string): () => Promise<never> {
  return async (): Promise<never> => {
    throw new Error(`Tool "${name}" is not implemented.`);
  };
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
  const proc = Bun.spawn([shellPath, login === false ? '-c' : '-lc', cmd], {
    cwd: workdir,
    stdout: 'pipe',
    stderr: 'pipe',
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

const bash = new Tool({
  name: 'Bash',
  description:
    'Executes a given bash command in a persistent shell session with optional timeout. Prefer dedicated tools (Read, Edit, Write, Glob, Grep) over Bash when one fits.',
  inputSchema: z.object({
    command: z.string().describe('The command to execute.'),
    description: z
      .string()
      .optional()
      .describe(
        'Clear, concise description of what this command does in 5-10 words, in active voice.',
      ),
    timeout: z
      .number()
      .int()
      .positive()
      .max(600_000)
      .optional()
      .describe('Optional timeout in milliseconds (max 600000).'),
    run_in_background: z
      .boolean()
      .optional()
      .describe('Set to true to run this command in the background.'),
  }),
  execute: async ({ command, timeout, run_in_background }): Promise<string> => {
    if (run_in_background) {
      throw new Error(
        'run_in_background requires runtime support and is not implemented in this harness.',
      );
    }
    return runShell({ cmd: command, timeout });
  },
});

const execCommand = new Tool({
  name: 'exec_command',
  description:
    'Runs a shell command and returns stdout, stderr, and the exit code when non-zero.',
  inputSchema: z.object({
    cmd: z.string().describe('Shell command to execute.'),
    workdir: z
      .string()
      .optional()
      .describe('Working directory to run the command in.'),
    shell: z.string().optional().describe('Shell binary to launch.'),
    login: z
      .boolean()
      .optional()
      .describe('Whether to run the shell with login semantics.'),
    tty: z
      .boolean()
      .optional()
      .describe('Pseudo-TTY allocation is not implemented.'),
    yield_time_ms: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Maximum time to wait before returning output.'),
    max_output_tokens: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Approximate maximum output tokens to return.'),
  }),
  execute: async ({
    cmd,
    workdir,
    shell,
    login,
    tty,
    yield_time_ms,
    max_output_tokens,
  }): Promise<string> => {
    if (tty) {
      throw new Error('tty requires runtime support and is not implemented.');
    }
    const output = await runShell({
      cmd,
      workdir,
      shell,
      login,
      timeout: yield_time_ms,
    });
    if (max_output_tokens === undefined) return output;
    return output.slice(0, max_output_tokens * 4);
  },
});

const read = new Tool({
  name: 'Read',
  description:
    'Reads a file from the local filesystem. Supports text, images, PDFs, and Jupyter notebooks. Returns content with line numbers in cat -n format.',
  inputSchema: z.object({
    file_path: z.string().describe('The absolute path to the file to read.'),
    offset: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'The line number to start reading from. Only provide if the file is too large to read at once.',
      ),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'The number of lines to read. Only provide if the file is too large to read at once.',
      ),
    pages: z
      .string()
      .optional()
      .describe(
        'Page range for PDF files (e.g., "1-5"). Only applicable to PDF files. Max 20 pages per request.',
      ),
  }),
  execute: async ({ file_path, offset, limit }): Promise<string> => {
    const content = await Bun.file(file_path).text();
    const lines = content.split('\n');
    const start = offset ?? 0;
    const end = limit !== undefined ? start + limit : lines.length;
    const slice = lines.slice(start, end);
    return slice
      .map(
        (line, i) => `${(start + i + 1).toString().padStart(6, ' ')}\t${line}`,
      )
      .join('\n');
  },
});

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

const edit = new Tool({
  name: 'Edit',
  description:
    'Performs exact string replacements in files. Must read the file at least once in the conversation before editing.',
  inputSchema: z.object({
    file_path: z.string().describe('The absolute path to the file to modify.'),
    old_string: z.string().describe('The text to replace.'),
    new_string: z
      .string()
      .describe('The text to replace it with (must differ from old_string).'),
    replace_all: z
      .boolean()
      .optional()
      .describe('Replace all occurrences of old_string (default false).'),
  }),
  execute: async ({
    file_path,
    old_string,
    new_string,
    replace_all,
  }): Promise<string> => {
    if (replace_all) {
      const content = await Bun.file(file_path).text();
      const updated = content.split(old_string).join(new_string);
      await Bun.write(file_path, updated);
      return `Edited ${file_path} (replace_all).`;
    }
    await applyExactReplacements(file_path, [
      { oldString: old_string, newString: new_string },
    ]);
    return `Edited ${file_path}.`;
  },
});

const write = new Tool({
  name: 'Write',
  description:
    'Writes a file to the local filesystem. Overwrites any existing file at the given path. Prefer Edit for modifying existing files.',
  inputSchema: z.object({
    file_path: z
      .string()
      .describe('The absolute path to the file to write (must be absolute).'),
    content: z.string().describe('The content to write to the file.'),
  }),
  execute: async ({ file_path, content }): Promise<string> => {
    await Bun.write(file_path, content);
    return `Wrote ${file_path}.`;
  },
});

const glob = new Tool({
  name: 'Glob',
  description:
    'Fast file pattern matching that works with any codebase size. Returns matching file paths sorted by modification time.',
  inputSchema: z.object({
    pattern: z.string().describe('The glob pattern to match files against.'),
    path: z
      .string()
      .optional()
      .describe('The directory to search in. Defaults to cwd if omitted.'),
  }),
  execute: async ({ pattern, path: searchPath }): Promise<string> => {
    const cwd = searchPath ?? process.cwd();
    const glob = new Bun.Glob(pattern);
    const matches: string[] = [];
    for await (const file of glob.scan({ cwd, onlyFiles: true })) {
      matches.push(resolve(cwd, file));
    }
    const withMtime = await Promise.all(
      matches.map(async (file) => ({
        file,
        mtime: (await stat(file)).mtimeMs,
      })),
    );
    withMtime.sort((a, b) => b.mtime - a.mtime);
    return withMtime.map(({ file }) => file).join('\n');
  },
});

const grep = new Tool({
  name: 'Grep',
  description:
    'A powerful search tool built on ripgrep. Supports full regex, file filtering by glob or type, and multiple output modes.',
  inputSchema: z.object({
    pattern: z
      .string()
      .describe('The regular expression pattern to search for.'),
    path: z
      .string()
      .optional()
      .describe('File or directory to search in. Defaults to cwd.'),
    glob: z
      .string()
      .optional()
      .describe('Glob pattern to filter files (e.g. "*.ts", "*.{js,tsx}").'),
    type: z
      .string()
      .optional()
      .describe('File type to search (rg --type), e.g. "js", "py", "rust".'),
    output_mode: z
      .enum(['content', 'files_with_matches', 'count'])
      .optional()
      .describe(
        'Output mode. Defaults to "files_with_matches". "content" supports -A/-B/-C and -n.',
      ),
    '-i': z.boolean().optional().describe('Case insensitive search.'),
    '-n': z
      .boolean()
      .optional()
      .describe(
        'Show line numbers (requires output_mode: "content"). Defaults to true.',
      ),
    '-A': z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'Lines to show after each match. Requires output_mode: content.',
      ),
    '-B': z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'Lines to show before each match. Requires output_mode: content.',
      ),
    '-C': z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'Lines of context before and after each match. Requires output_mode: content.',
      ),
    '-o': z
      .boolean()
      .optional()
      .describe('Print only the matched parts of each matching line.'),
    multiline: z
      .boolean()
      .optional()
      .describe(
        'Enable multiline mode where . matches newlines and patterns can span lines.',
      ),
    head_limit: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Limit output to first N lines/entries. 0 means unlimited.'),
    offset: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'Skip first N lines/entries before applying head_limit. Defaults to 0.',
      ),
  }),
  execute: async (args): Promise<string> => {
    if (args.multiline) {
      throw new Error(
        'multiline mode is not supported by grep. Install ripgrep for this feature.',
      );
    }

    const grepPath = Bun.which('grep');
    if (!grepPath) {
      throw new Error('grep not found in PATH.');
    }

    const typeGlobs: Record<string, string[]> = {
      js: ['*.js', '*.mjs', '*.cjs'],
      ts: ['*.ts', '*.tsx', '*.mts', '*.cts'],
      tsx: ['*.tsx'],
      jsx: ['*.jsx'],
      py: ['*.py', '*.pyi'],
      rust: ['*.rs'],
      go: ['*.go'],
      java: ['*.java'],
      md: ['*.md', '*.markdown'],
      json: ['*.json'],
      yaml: ['*.yaml', '*.yml'],
      toml: ['*.toml'],
      css: ['*.css', '*.scss', '*.sass'],
      html: ['*.html', '*.htm'],
      sh: ['*.sh', '*.bash', '*.zsh'],
    };

    const cmd: string[] = [
      grepPath,
      '-r',
      '-E',
      '--exclude-dir=node_modules',
      '--exclude-dir=.git',
    ];
    if (args['-i']) cmd.push('-i');

    const mode = args.output_mode ?? 'files_with_matches';
    if (mode === 'files_with_matches') {
      cmd.push('-l');
    } else if (mode === 'count') {
      cmd.push('-c');
    } else {
      if (args['-n'] !== false) cmd.push('-n');
      if (args['-A'] !== undefined) cmd.push('-A', String(args['-A']));
      if (args['-B'] !== undefined) cmd.push('-B', String(args['-B']));
      if (args['-C'] !== undefined) cmd.push('-C', String(args['-C']));
      if (args['-o']) cmd.push('-o');
    }

    if (args.glob) cmd.push(`--include=${args.glob}`);
    if (args.type) {
      const globs = typeGlobs[args.type];
      if (!globs) {
        throw new Error(`Unknown file type: ${args.type}`);
      }
      for (const g of globs) cmd.push(`--include=${g}`);
    }

    cmd.push('--', args.pattern, args.path ?? '.');

    const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    if (exitCode !== 0 && exitCode !== 1) {
      throw new Error(`grep failed (exit ${exitCode}): ${stderr.trim()}`);
    }

    let lines = stdout.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const offset = args.offset ?? 0;
    const headLimit = args.head_limit ?? 250;
    if (offset > 0) lines = lines.slice(offset);
    if (headLimit > 0) lines = lines.slice(0, headLimit);
    return lines.join('\n');
  },
});

const webFetch = new Tool({
  name: 'WebFetch',
  description:
    'Fetches content from a specified URL and processes it using an AI model. Use when the user provides a URL.',
  inputSchema: z.object({
    url: z.url().describe('The URL to fetch content from.'),
    prompt: z.string().describe('The prompt to run on the fetched content.'),
  }),
  deferred: true,
  execute: async ({ url, prompt }, ctx): Promise<string> => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status}`);
    }
    const body = await response.text();
    const cleaned = body
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return ctx.complete(
      `${prompt}\n\n---\n\nContent from ${url}:\n\n${cleaned}`,
    );
  },
});

const webSearch = new Tool({
  name: 'WebSearch',
  description:
    'Search the web and use the results to inform responses. Useful for up-to-date information beyond the model knowledge cutoff.',
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
  deferred: true,
  execute: (
    { query, allowed_domains, blocked_domains },
    ctx,
  ): Promise<SearchHit[]> =>
    ctx.searchWeb(query, {
      allowedDomains: allowed_domains,
      blockedDomains: blocked_domains,
    }),
});

const codexWebSearch = new Tool({
  name: 'web_search',
  description:
    'Search the web for up-to-date information beyond the model knowledge cutoff.',
  inputSchema: z.object({
    query: z.string().min(2).describe('The search query to use.'),
    allowed_domains: z.array(z.string()).optional(),
    blocked_domains: z.array(z.string()).optional(),
  }),
  deferred: true,
  execute: (
    { query, allowed_domains, blocked_domains },
    ctx,
  ): Promise<SearchHit[]> =>
    ctx.searchWeb(query, {
      allowedDomains: allowed_domains,
      blockedDomains: blocked_domains,
    }),
});

const toolSearch = new Tool({
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

interface Task {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'deleted';
  blocks: string[];
  blockedBy: string[];
  metadata?: Record<string, unknown>;
}

function getTasks(ctx: ToolContext, key: string): Task[] {
  return (ctx.session.store.get(key) as Task[] | undefined) ?? [];
}

function setTasks(ctx: ToolContext, key: string, tasks: Task[]): void {
  ctx.session.store.set(key, tasks);
}

function createTaskTools(key: string): Tool[] {
  const taskCreate = new Tool({
    name: 'TaskCreate',
    description:
      'Create a structured task in the session task list. Use for multi-step or complex work.',
    inputSchema: z.object({
      subject: z
        .string()
        .describe('A brief, imperative-form title for the task.'),
      description: z.string().describe('What needs to be done.'),
      activeForm: z
        .string()
        .optional()
        .describe(
          'Present-continuous form shown in the spinner when the task is in_progress.',
        ),
      metadata: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Arbitrary metadata to attach to the task.'),
    }),
    deferred: true,
    execute: (input, ctx): Task => {
      const task: Task = {
        id: crypto.randomUUID(),
        subject: input.subject,
        description: input.description,
        activeForm: input.activeForm,
        status: 'pending',
        blocks: [],
        blockedBy: [],
        metadata: input.metadata,
      };
      setTasks(ctx, key, [...getTasks(ctx, key), task]);
      return task;
    },
  });

  const taskUpdate = new Tool({
    name: 'TaskUpdate',
    description:
      'Update a task in the session task list (status, subject, dependencies, etc.).',
    inputSchema: z.object({
      taskId: z.string().describe('The ID of the task to update.'),
      status: z
        .enum(['pending', 'in_progress', 'completed', 'deleted'])
        .optional()
        .describe('New status for the task.'),
      subject: z.string().optional(),
      description: z.string().optional(),
      activeForm: z.string().optional(),
      addBlocks: z.array(z.string()).optional(),
      addBlockedBy: z.array(z.string()).optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
    deferred: true,
    execute: (input, ctx): Task => {
      const tasks = getTasks(ctx, key);
      const idx = tasks.findIndex((task) => task.id === input.taskId);
      if (idx === -1) {
        throw new Error(`Task ${input.taskId} not found.`);
      }
      const prev = tasks[idx];
      if (!prev) {
        throw new Error(`Task ${input.taskId} not found.`);
      }
      const next: Task = {
        ...prev,
        status: input.status ?? prev.status,
        subject: input.subject ?? prev.subject,
        description: input.description ?? prev.description,
        activeForm: input.activeForm ?? prev.activeForm,
        blocks: input.addBlocks
          ? [...prev.blocks, ...input.addBlocks]
          : prev.blocks,
        blockedBy: input.addBlockedBy
          ? [...prev.blockedBy, ...input.addBlockedBy]
          : prev.blockedBy,
        metadata: input.metadata ?? prev.metadata,
      };
      const updated = [...tasks];
      updated[idx] = next;
      setTasks(ctx, key, updated);
      return next;
    },
  });

  const taskList = new Tool({
    name: 'TaskList',
    description: 'List tasks in the current session task list.',
    inputSchema: z.object({}),
    deferred: true,
    execute: (_input, ctx): Task[] => getTasks(ctx, key),
  });

  const taskGet = new Tool({
    name: 'TaskGet',
    description: 'Get the latest state of a specific task.',
    inputSchema: z.object({
      taskId: z.string().describe('The ID of the task to fetch.'),
    }),
    deferred: true,
    execute: (input, ctx): Task => {
      const task = getTasks(ctx, key).find((t) => t.id === input.taskId);
      if (!task) {
        throw new Error(`Task ${input.taskId} not found.`);
      }
      return task;
    },
  });

  return [taskCreate, taskUpdate, taskList, taskGet];
}

function createUpdatePlanTool(key: string): Tool {
  return new Tool({
    name: 'update_plan',
    description: 'Updates the task plan with a concise list of steps.',
    inputSchema: z.object({
      explanation: z
        .string()
        .optional()
        .describe('Optional explanation for why the plan changed.'),
      plan: z.array(
        z.object({
          step: z.string().describe('A concise plan step.'),
          status: z.enum(['pending', 'in_progress', 'completed']),
        }),
      ),
    }),
    execute: ({ explanation, plan }, ctx): string => {
      const activeCount = plan.filter(
        (item) => item.status === 'in_progress',
      ).length;
      if (activeCount > 1) {
        throw new Error('At most one plan item can be in_progress.');
      }
      ctx.session.store.set(key, plan);
      const lines = plan.map((item) => `- ${item.status}: ${item.step}`);
      if (explanation) return `${explanation}\n${lines.join('\n')}`;
      return lines.join('\n');
    },
  });
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

async function applyPatchText(patch: string): Promise<string> {
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines[0] !== '*** Begin Patch') {
    throw new Error('Patch must start with "*** Begin Patch".');
  }
  if (lines.at(-1) !== '*** End Patch') {
    throw new Error('Patch must end with "*** End Patch".');
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
      await mkdir(dirname(addFile), { recursive: true });
      await writeFile(addFile, `${content.join('\n')}\n`);
      changed.push(`added ${addFile}`);
      continue;
    }

    const deleteFile = consumePrefixedLine(lines, index, '*** Delete File: ');
    if (deleteFile !== undefined) {
      await rm(deleteFile);
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

    let content = await Bun.file(updateFile).text();
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

    const target = moveTo ?? updateFile;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
    if (moveTo !== undefined) await rm(updateFile);
    changed.push(
      moveTo === undefined
        ? `updated ${target}`
        : `moved ${updateFile} to ${target}`,
    );
  }

  return changed.join('\n');
}

const applyPatch = new Tool({
  name: 'apply_patch',
  description:
    'Applies a patch in the Codex apply_patch format. The patch must include Begin Patch and End Patch markers.',
  inputSchema: z.object({
    patch: z.string().describe('The full apply_patch patch text.'),
  }),
  execute: ({ patch }): Promise<string> => applyPatchText(patch),
});

export {
  applyPatch,
  applyExactReplacements,
  bash,
  codexWebSearch,
  createTaskTools,
  createUpdatePlanTool,
  edit,
  execCommand,
  glob,
  grep,
  notImplemented,
  read,
  toolSearch,
  webFetch,
  webSearch,
  write,
};
