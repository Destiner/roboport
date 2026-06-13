import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Agent } from 'roboport';
import { codex } from 'roboport/harness';
import { OpenAI } from 'roboport/models';
import { developerExperience } from 'roboport/skills';
import type { PullRequestEvent } from 'roboport/triggers';

import type { Config } from '../config';
import { startCheckRun } from '../github';

function createDxAuditAgent(config: Config): Agent {
  return new Agent({
    model: new OpenAI('gpt-5.5', {
      auth: { type: 'codex', authFile: config.codexAuthFile },
      thinking: 'high',
    }),
    system: codex.system,
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
4. Post the findings as a single summary comment: write the report (the skill's output format and verdict verbatim) to ${workspace}/audit.md, then post it with \`gh pr review ${number} --comment --body-file ${workspace}/audit.md\`. Always use --comment; never --approve or --request-changes — a DX papercut must not gate a merge. If there is nothing the change introduces worth raising, print "no surface change" and post nothing.

The GH_TOKEN env var is set and gh is authenticated.`;
}

async function handleDxAudit(
  agent: Agent,
  event: PullRequestEvent,
): Promise<void> {
  const tag = `${event.repository.full_name}#${event.number}`;
  console.log(`[dx-audit] started ${tag} action=${event.action}`);
  const workspace = await mkdtemp(join(tmpdir(), 'roboport-dx-audit-'));
  const check = await startCheckRun(
    event.repository.full_name,
    event.pull_request.head.sha,
    'roboport / dx-audit',
  );
  try {
    await using session = agent.session();
    await session.send(buildPrompt(event, workspace));
    await check?.complete(
      'neutral',
      'DX audit complete',
      "Audited the PR's public surface for DX/AX papercuts.",
    );
    console.log(`[dx-audit] finished ${tag}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[dx-audit] failed ${tag}: ${message}`);
    await check?.complete('failure', 'DX audit failed', message);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

export { createDxAuditAgent, handleDxAudit };
