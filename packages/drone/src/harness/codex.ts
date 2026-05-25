import { z } from 'zod';

import { Tool, type SearchHit } from '@/core';

import { Harness } from './core';
import { applyPatchText, createToolSearch, runShell } from './shared';

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
  execute: async (
    { cmd, workdir, shell, login, tty, yield_time_ms, max_output_tokens },
    ctx,
  ): Promise<string> => {
    if (tty) {
      throw new Error('tty requires runtime support and is not implemented.');
    }
    const output = await runShell({
      cmd,
      workdir: workdir ?? ctx.cwd,
      shell,
      login,
      timeout: yield_time_ms,
    });
    if (max_output_tokens === undefined) return output;
    return output.slice(0, max_output_tokens * 4);
  },
});

const applyPatch = new Tool({
  name: 'apply_patch',
  description:
    'Applies a patch in the Codex apply_patch format. The patch must include Begin Patch and End Patch markers.',
  inputSchema: z.object({
    patch: z.string().describe('The full apply_patch patch text.'),
  }),
  execute: ({ patch }, ctx): Promise<string> =>
    applyPatchText(patch, { cwd: ctx.cwd }),
});

const webSearch = new Tool({
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

const PLAN_STORE_KEY = 'codex.plan';

const updatePlan = new Tool({
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
    ctx.session.store.set(PLAN_STORE_KEY, plan);
    const lines = plan.map((item) => `- ${item.status}: ${item.step}`);
    if (explanation) return `${explanation}\n${lines.join('\n')}`;
    return lines.join('\n');
  },
});

const system = `You are a coding agent running in a Codex-style harness.
You help users modify, inspect, and explain code in the current workspace. Be precise, safe, and concise.

# AGENTS.md
- Repositories may contain AGENTS.md files with instructions for the directory tree rooted where they appear.
- Follow every AGENTS.md that applies to files you read or edit.
- More deeply nested AGENTS.md files override higher-level ones.
- Direct system, developer, and user instructions override AGENTS.md.

# Working Style
- Keep working until the user's task is handled end to end, unless they ask you to stop or approve a plan first.
- Read the code before changing it, and prefer local patterns over new abstractions.
- Keep edits focused. Avoid unrelated refactors, speculative compatibility layers, and obvious comments.
- Do not overwrite user changes or run destructive commands unless explicitly asked.
- For exploratory or planning requests, answer with a concise recommendation and tradeoff before editing.

# Tools
- Use exec_command for shell commands. Prefer rg or rg --files for search when available; otherwise use grep or find.
- Use apply_patch for manual file edits. This harness exposes apply_patch as JSON: pass the full patch in the "patch" field.
- apply_patch patch text must use this shape: "*** Begin Patch", then file operations such as "*** Add File: path" with every added line prefixed by "+", then "*** End Patch".
- Use update_plan for non-trivial multi-step work, keeping exactly one item in_progress until everything is complete.
- Use ToolSearch to load deferred tools before calling them.
- Use web_search only when current or external information is needed.

# Communication
- Before tool calls, briefly state what you are about to do.
- Share short progress updates when you find something important, change direction, or hit a blocker.
- Final answers should say what changed and what validation ran. Keep them short unless details matter.`;

const tools: Tool[] = [
  execCommand,
  applyPatch,
  updatePlan,
  webSearch,
  createToolSearch(),
];

const harness = new Harness(system, tools);

export default harness;
