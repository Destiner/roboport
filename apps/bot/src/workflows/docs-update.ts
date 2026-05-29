import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Agent } from 'drone';
import { codex } from 'drone/harness';
import { OpenAIModel } from 'drone/models';
import { docsUpdate } from 'drone/skills';
import type { PullRequestEvent } from 'drone/triggers';

import type { Config } from '../config';
import { startCheckRun } from '../github';
import { logMessages } from '../log';

function createDocsUpdateAgent(config: Config): Agent {
  return new Agent({
    model: new OpenAIModel('gpt-5.5', {
      auth: { type: 'codex', authFile: config.codexAuthFile },
      thinking: 'medium',
    }),
    prompt: codex.system,
    tools: codex.tools,
    skills: [docsUpdate],
  });
}

function buildPrompt(
  event: PullRequestEvent,
  workspace: string,
  config: Config,
): string {
  const repo = event.repository.full_name;
  const number = event.number;
  const headRef = event.pull_request.head.ref;
  const baseRef = event.pull_request.base.ref;
  return `Workspace: ${workspace}
IMPORTANT: pass workdir=${workspace} (or a subdirectory) to every exec_command call. There is no default working directory.

You are updating internal docs for PR #${number} in ${repo}.
Branch: ${headRef}. Base: origin/${baseRef}.

1. Clone and check out the PR head, configure git identity:
   - gh repo clone ${repo} repo
   - cd repo && gh pr checkout ${number}
   - git config user.name "${config.gitUserName.replace(/"/g, '\\"')}"
   - git config user.email "${config.gitUserEmail.replace(/"/g, '\\"')}"
2. Diff against origin/${baseRef} and apply the docs-update skill.
3. If no edits are warranted, print "docs in sync" and stop — do not commit.
4. If you applied edits:
   - Run \`bun install\`, then \`bun run check\` and \`bun run typecheck\`.
   - Stage only the docs files you edited.
   - Commit with message: \`docs: sync internal docs with PR #${number}\` followed by a blank line and \`[skip ci]\`.
   - Push to origin/${headRef}.

Do not amend or force-push. Do not edit source files. The GH_TOKEN env var is set and gh is authenticated; git push works via gh's credential helper.`;
}

async function handleDocsUpdate(
  agent: Agent,
  event: PullRequestEvent,
  config: Config,
): Promise<void> {
  const tag = `${event.repository.full_name}#${event.number}`;
  const workspace = await mkdtemp(join(tmpdir(), 'drone-docs-update-'));
  const check = await startCheckRun(
    event.repository.full_name,
    event.pull_request.head.sha,
    'drone / docs',
  );
  try {
    await using session = agent.session();
    await session.send(buildPrompt(event, workspace, config));
    logMessages(`docs-update:${tag}`, [...session.messages]);
    await check?.complete(
      'neutral',
      'Docs check complete',
      'Checked the internal docs against the PR diff.',
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[bot] docs-update failed for ${tag}: ${message}`);
    await check?.complete('failure', 'Docs check failed', message);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

export { createDocsUpdateAgent, handleDocsUpdate };
