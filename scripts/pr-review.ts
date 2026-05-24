import { Agent } from '@/core';
import { codex } from '@/harness';
import { OpenAIModel } from '@/models';
import { prReview } from '@/skills';

import { logMessages } from '../examples/common';

const prNumber = process.env.PR_NUMBER;
const repo = process.env.GITHUB_REPOSITORY;

if (!prNumber) throw new Error('PR_NUMBER is required');
if (!repo) throw new Error('GITHUB_REPOSITORY is required');

const agent = new Agent({
  model: new OpenAIModel('gpt-5.5'),
  prompt: codex.system,
  tools: codex.tools,
  skills: [prReview],
});

const session = await agent.createSession({
  prompt: `Review PR #${prNumber} in ${repo} and post your findings to GitHub.

You are explicitly authorized to post:
- One inline comment per line-level finding via \`gh api repos/${repo}/pulls/${prNumber}/comments\`.
- A summary review with the severity-tiered markdown body and verdict via \`gh pr review ${prNumber}\` (\`--comment\`, or \`--request-changes\` if the verdict is Request changes).

Skip inline comments if there are no line-level findings.`,
});

logMessages(session.messages);
