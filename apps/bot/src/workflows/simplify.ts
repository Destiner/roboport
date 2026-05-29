import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Agent } from 'drone';
import { codex } from 'drone/harness';
import { OpenAIModel } from 'drone/models';
import { codeSimplifier } from 'drone/skills';
import type {
  PullRequestEvent,
  PullRequestReviewCommentEvent,
} from 'drone/triggers';

import type { Config } from '../config';
import {
  deleteReviewComment,
  editReviewComment,
  postThreadReply,
  startCheckRun,
} from '../github';

// Appended to every simplification idea comment so review-comment replies can be
// routed back to this workflow. pr-review also posts bot-authored inline
// comments, so the reply gate matches on this marker, not just authorship.
const SIMPLIFY_IDEA_MARKER = '<!-- drone-simplify-idea -->';

function createSimplifyAgent(config: Config): Agent {
  return new Agent({
    model: new OpenAIModel('gpt-5.5', {
      auth: { type: 'codex', authFile: config.codexAuthFile },
      thinking: 'medium',
    }),
    prompt: codex.system,
    tools: codex.tools,
    skills: [codeSimplifier],
  });
}

function buildIdeasPrompt(event: PullRequestEvent, workspace: string): string {
  const repo = event.repository.full_name;
  const number = event.number;
  const headSha = event.pull_request.head.sha;
  return `Workspace: ${workspace}
IMPORTANT: pass workdir=${workspace} (or a subdirectory) to every exec_command call. There is no default working directory.

You are suggesting simplifications for PR #${number} in ${repo}, in SUGGEST-ONLY mode — you must NOT modify the PR.

1. Clone the repo and check out the PR head:
   - gh repo clone ${repo} repo
   - cd repo && gh pr checkout ${number}
2. Apply the code-simplifier skill to the PR diff only (changed lines and their immediate context). You cannot apply edits here, so surface every worthwhile simplification as a suggestion — the skill's suggestion fallback — never an in-place edit.
3. Post each idea as a SINGLE inline review comment, anchored to path + line on head commit ${headSha}:
   - gh api repos/${repo}/pulls/${number}/comments -f body=... -f commit_id=${headSha} -f path=... -F line=...
   - One comment per idea. Describe the simplification and why (cite the rule or local convention). Prose only — do NOT use \`\`\`suggestion blocks.
   - Second-to-last line: invite the author to reply in the thread to have you apply it, adjustments welcome.
   - Last line: this marker verbatim, unchanged, on its own line: ${SIMPLIFY_IDEA_MARKER}
4. Do NOT post a summary review. If there are no worthwhile, behaviour-preserving simplifications, print "no simplifications" and post nothing.

Stay diff-scoped and conservative: skip anything a correctness/security reviewer would already flag, and skip pure style a linter handles. The GH_TOKEN env var is set and gh is authenticated.`;
}

function buildApplyPrompt(
  event: PullRequestReviewCommentEvent,
  workspace: string,
  config: Config,
): string {
  const repo = event.repository.full_name;
  const number = event.pull_request.number;
  const headRef = event.pull_request.head.ref;
  const rootId = event.comment.in_reply_to_id;
  const replyId = event.comment.id;
  return `Workspace: ${workspace}
IMPORTANT: pass workdir=${workspace} (or a subdirectory) to every exec_command call. There is no default working directory.

A reviewer replied in an inline comment thread on PR #${number} in ${repo}. You posted a simplification idea as the root of this thread (comment ${rootId}); ${event.sender.login} replied (comment ${replyId}):
"""
${event.comment.body}
"""

1. Read the thread for full context:
   - gh api repos/${repo}/pulls/comments/${rootId} — your original idea.
   - gh api "repos/${repo}/pulls/${number}/comments" — find every comment whose in_reply_to_id is ${rootId} to see the whole discussion.
2. Decide what the reply asks for:
   - Asking you to apply the simplification (with or without adjustments, e.g. "yes, and also rename X") → proceed to step 3, folding in any steering.
   - A question, pushback, or general discussion → do NOT change code. Optionally answer once in the thread, then stop.
   - You already pushed a commit for this idea earlier in the thread → stop.
3. If applying:
   - gh repo clone ${repo} repo
   - cd repo && gh pr checkout ${number}
   - git config user.name "${config.gitUserName.replace(/"/g, '\\"')}"
   - git config user.email "${config.gitUserEmail.replace(/"/g, '\\"')}"
   - Apply the code-simplifier skill to implement the specific change discussed, in place. Keep it behaviour-preserving and scoped to the idea plus the reviewer's adjustments.
   - Run \`bun install\`, then \`bun run check\` and \`bun run typecheck\`. If they fail and you cannot fix them within the change's scope, stop without committing.
   - Stage only the files you changed. Commit with a \`refactor:\` message describing the simplification. Do NOT add [skip ci].
   - Push to origin/${headRef}.
   - Reply in the thread (gh api repos/${repo}/pulls/${number}/comments -f in_reply_to=${rootId} -f body=...) linking the commit you pushed. Thread replies anchor to the root comment ${rootId}, not the triggering reply.

Do not amend or force-push. Do not touch unrelated code. The GH_TOKEN env var is set and gh is authenticated; git push works via gh's credential helper.`;
}

async function handleSimplifyIdeas(
  agent: Agent,
  event: PullRequestEvent,
): Promise<void> {
  const tag = `${event.repository.full_name}#${event.number}`;
  console.log(`[simplify-ideas] started ${tag} action=${event.action}`);
  const workspace = await mkdtemp(join(tmpdir(), 'drone-simplify-ideas-'));
  const check = await startCheckRun(
    event.repository.full_name,
    event.pull_request.head.sha,
    'drone / simplify',
  );
  try {
    await using session = agent.session();
    await session.send(buildIdeasPrompt(event, workspace));
    await check?.complete(
      'neutral',
      'Simplify scan complete',
      'Scanned the PR diff for behaviour-preserving simplifications.',
    );
    console.log(`[simplify-ideas] finished ${tag}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[simplify-ideas] failed ${tag}: ${message}`);
    await check?.complete('failure', 'Simplify scan failed', message);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function handleSimplifyReply(
  agent: Agent,
  event: PullRequestReviewCommentEvent,
  config: Config,
): Promise<void> {
  const repo = event.repository.full_name;
  const number = event.pull_request.number;
  const tag = `${repo}#${number}`;
  console.log(`[simplify-apply] started ${tag} comment=${event.comment.id}`);
  // in_reply_to_id is always set here — isReplyActionable gates on it.
  const rootId = event.comment.in_reply_to_id;
  if (rootId === undefined) return;
  const workspace = await mkdtemp(join(tmpdir(), 'drone-simplify-apply-'));
  // No head-sha check run fits the reply path (it commits back to the branch),
  // so acknowledge progress with a placeholder reply in the thread. The agent
  // posts the real outcome (a commit link, an answer, or nothing), so on
  // success the placeholder is deleted; on failure it becomes an error note.
  const placeholderId = await postThreadReply(
    repo,
    number,
    rootId,
    '🤖 _Working on it…_',
  );
  try {
    await using session = agent.session();
    await session.send(buildApplyPrompt(event, workspace, config));
    if (placeholderId !== null) await deleteReviewComment(repo, placeholderId);
    console.log(`[simplify-apply] finished ${tag}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[simplify-apply] failed ${tag}: ${message}`);
    if (placeholderId !== null) {
      await editReviewComment(
        repo,
        placeholderId,
        '🤖 _I hit an error applying this. Check the bot logs._',
      );
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

export {
  createSimplifyAgent,
  handleSimplifyIdeas,
  handleSimplifyReply,
  SIMPLIFY_IDEA_MARKER,
};
