import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Agent } from 'drone';
import { codex } from 'drone/harness';
import { OpenAIModel } from 'drone/models';
import { developerExperience } from 'drone/skills';
import type { PullRequestEvent } from 'drone/triggers';

import type { Config } from '../config';
import { logMessages } from '../log';

function createDxAuditAgent(config: Config): Agent {
  return new Agent({
    model: new OpenAIModel('gpt-5.5', {
      auth: { type: 'codex', authFile: config.codexAuthFile },
      thinking: 'high',
    }),
    prompt: codex.system,
    tools: codex.tools,
    skills: [developerExperience],
  });
}

function buildPrompt(event: PullRequestEvent, workspace: string): string {
  const repo = event.repository.full_name;
  const number = event.number;
  return `Workspace: ${workspace}
IMPORTANT: pass workdir=${workspace} (or a subdirectory) to every exec_command call. There is no default working directory.

Audit PR #${number} in ${repo} for developer experience (DX) and agent experience (AX), scoped to this PR's changes.

1. Clone the repo and check out the PR head:
   - gh repo clone ${repo} repo
   - cd repo && gh pr checkout ${number}
2. First, decide whether this PR changes the PUBLIC SURFACE — exported symbols, API endpoints, error types, public types, CLI flags, tool/MCP definitions, or configuration/environment contracts that a consumer depends on. If it does NOT touch the public surface, print "no surface change" and STOP — post nothing.
3. If it does touch the public surface, apply the developer-experience skill with scope = this PR's diff (the surface the change adds, removes, or alters, plus its immediate blast radius). Report only papercuts the change itself introduces or worsens — not pre-existing debt it merely sits next to.
4. Post the findings as a single summary comment via \`gh pr review ${number} --comment\`. Always use --comment; never --approve or --request-changes. Use the skill's output format and verdict verbatim. If there is nothing the change introduces worth raising, print "no surface change" and post nothing.

The GH_TOKEN env var is set and gh is authenticated.`;
}

async function handleDxAudit(
  agent: Agent,
  event: PullRequestEvent,
): Promise<void> {
  const tag = `${event.repository.full_name}#${event.number}`;
  const workspace = await mkdtemp(join(tmpdir(), 'drone-dx-audit-'));
  try {
    await using session = agent.session();
    await session.send(buildPrompt(event, workspace));
    logMessages(`dx-audit:${tag}`, [...session.messages]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[bot] dx-audit failed for ${tag}: ${message}`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

export { createDxAuditAgent, handleDxAudit };
