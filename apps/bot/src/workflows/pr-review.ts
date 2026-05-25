import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Agent } from 'drone';
import { codex } from 'drone/harness';
import { OpenAIModel } from 'drone/models';
import { prReview } from 'drone/skills';
import type { PullRequestEvent } from 'drone/triggers';

import type { Config } from '../config';
import { logMessages } from '../log';

function createPrReviewAgent(config: Config): Agent {
  return new Agent({
    model: new OpenAIModel('gpt-5.5', {
      auth: { type: 'codex', authFile: config.codexAuthFile },
      thinking: 'high',
    }),
    prompt: codex.system,
    tools: codex.tools,
    skills: [prReview],
  });
}

function buildPrompt(event: PullRequestEvent, workspace: string): string {
  const repo = event.repository.full_name;
  const number = event.number;
  return `Workspace: ${workspace}
IMPORTANT: pass workdir=${workspace} (or a subdirectory) to every exec_command call. There is no default working directory.

Review PR #${number} in ${repo}.

1. Clone the repo and check out the PR head:
   - gh repo clone ${repo} repo
   - cd repo && gh pr checkout ${number}
2. Apply the pr-review skill.
3. Post your findings to GitHub (you are authorized):
   - One inline comment per line-level finding via gh api repos/${repo}/pulls/${number}/comments
   - A summary review via \`gh pr review ${number} --comment\`. Always use --comment; never --approve or --request-changes (GitHub refuses both on the PAT owner's own PRs). Use the output format from the pr-review skill verbatim (overview → findings → verdict).
   Skip inline comments if there are no line-level findings.

The GH_TOKEN env var is set and gh is authenticated.`;
}

async function handlePrReview(
  agent: Agent,
  event: PullRequestEvent,
): Promise<void> {
  const tag = `${event.repository.full_name}#${event.number}`;
  const workspace = await mkdtemp(join(tmpdir(), 'drone-pr-review-'));
  try {
    const session = await agent.createSession({
      prompt: buildPrompt(event, workspace),
    });
    logMessages(`pr-review:${tag}`, session.messages);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[bot] pr-review failed for ${tag}: ${message}`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

export { createPrReviewAgent, handlePrReview };
