import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Agent } from 'roboport';
import { codex } from 'roboport/harness';
import { OpenAIModel } from 'roboport/models';
import { docsUpdate } from 'roboport/skills';
import type { PullRequestEvent } from 'roboport/triggers';

import type { Config } from '../config';
import { prHeadSha, startCheckRun } from '../github';

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
   - Commit with message: \`docs: sync internal docs with PR #${number}\`.
   - Push to origin/${headRef}.

Do not amend or force-push. Do not edit source files. The GH_TOKEN env var is set and gh is authenticated; git push works via gh's credential helper.`;
}

async function handleDocsUpdate(
  agent: Agent,
  event: PullRequestEvent,
  config: Config,
): Promise<void> {
  const repo = event.repository.full_name;
  const startSha = event.pull_request.head.sha;
  const tag = `${repo}#${event.number}`;
  console.log(`[docs-update] started ${tag} action=${event.action}`);
  const workspace = await mkdtemp(join(tmpdir(), 'roboport-docs-update-'));
  const check = await startCheckRun(repo, startSha, 'roboport / docs');
  const summary = 'Checked the internal docs against the PR diff.';
  try {
    await using session = agent.session();
    await session.send(buildPrompt(event, workspace, config));
    await check?.complete('neutral', 'Docs check complete', summary);
    // The agent may have pushed a docs commit, advancing the head to a commit
    // that won't re-trigger this workflow (it's the bot's own push, which the
    // actor allowlist drops), so mirror the completion onto the new head too.
    const headSha = await prHeadSha(repo, event.number);
    if (headSha !== null && headSha !== startSha) {
      const headCheck = await startCheckRun(repo, headSha, 'roboport / docs');
      await headCheck?.complete('neutral', 'Docs check complete', summary);
    }
    console.log(`[docs-update] finished ${tag}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[docs-update] failed ${tag}: ${message}`);
    await check?.complete('failure', 'Docs check failed', message);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

export { createDocsUpdateAgent, handleDocsUpdate };
