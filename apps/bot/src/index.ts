import {
  githubTrigger,
  type PullRequestEvent,
  type PullRequestReviewCommentEvent,
} from 'drone/triggers';
import { Hono } from 'hono';

import { loadConfig } from './config';
import { GithubApp } from './github-app';
import {
  createDocsUpdateAgent,
  handleDocsUpdate,
} from './workflows/docs-update';
import { createDxAuditAgent, handleDxAudit } from './workflows/dx-audit';
import { createPrReviewAgent, handlePrReview } from './workflows/pr-review';
import {
  createSimplifyAgent,
  handleSimplifyIdeas,
  handleSimplifyReply,
  SIMPLIFY_IDEA_MARKER,
} from './workflows/simplify';

const config = loadConfig();

// Authenticate as the GitHub App: mint an installation token into
// process.env.GH_TOKEN, then learn the bot's identity before configuring git
// or wiring triggers. Bun does not propagate runtime process.env mutations to
// children implicitly, so every gh/git spawn passes env: process.env (here,
// below, and in the harness shell tool).
const githubApp = new GithubApp(config.app);
await githubApp.init();

// Fall back to the app's bot identity when no explicit git author is set, so
// commits link to the app instead of a person.
if (!config.gitUserName) config.gitUserName = githubApp.botName;
if (!config.gitUserEmail) config.gitUserEmail = githubApp.botEmail;

const ghAuthSetup = Bun.spawnSync(
  ['gh', 'auth', 'setup-git', '--hostname', 'github.com'],
  { env: process.env },
);
if (ghAuthSetup.exitCode !== 0) {
  const stderr = new TextDecoder().decode(ghAuthSetup.stderr);
  throw new Error(`gh auth setup-git failed: ${stderr}`);
}

// The account the bot posts as; used to recognise its own review threads.
const botLogin = githubApp.botLogin;

const ghReceiver = githubTrigger({ secret: config.webhookSecret });

const prReviewAgent = createPrReviewAgent(config);
const docsUpdateAgent = createDocsUpdateAgent(config);
const simplifyAgent = createSimplifyAgent(config);
const dxAuditAgent = createDxAuditAgent(config);

const SKIP_CI_PATTERN = /\[(?:skip[ -]ci|ci[ -]skip|no ci)\]/i;

async function headCommitMessage(
  event: PullRequestEvent,
): Promise<string | null> {
  const repo = event.repository.full_name;
  const sha = event.pull_request.head.sha;
  const proc = Bun.spawn(
    ['gh', 'api', `repos/${repo}/commits/${sha}`, '--jq', '.commit.message'],
    { stdout: 'pipe', stderr: 'pipe', env: process.env },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    console.error(
      `[bot] gh api failed for ${repo}@${sha}: ${stderr.trim() || `exit ${exitCode}`}`,
    );
    return null;
  }
  return (await new Response(proc.stdout).text()).trim();
}

async function isEventActionable(event: PullRequestEvent): Promise<boolean> {
  if (event.pull_request.draft) return false;
  // The bot is allowed here (so its own pushes re-trigger review) but not in
  // isReplyActionable, so it never acts on its own review-thread replies.
  if (
    !config.allowedActors.includes(event.sender.login) &&
    event.sender.login !== botLogin
  ) {
    return false;
  }
  if (event.pull_request.head.repo?.full_name !== event.repository.full_name) {
    return false;
  }
  if (event.action === 'synchronize') {
    const message = await headCommitMessage(event);
    if (message !== null && SKIP_CI_PATTERN.test(message)) {
      const tag = `${event.repository.full_name}#${event.number}`;
      console.log(`[bot] skip ${tag}: head commit has [skip ci]`);
      return false;
    }
  }
  return true;
}

async function reviewComment(
  repo: string,
  commentId: number,
): Promise<{ author: string; body: string } | null> {
  const proc = Bun.spawn(
    ['gh', 'api', `repos/${repo}/pulls/comments/${commentId}`],
    { stdout: 'pipe', stderr: 'pipe', env: process.env },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    console.error(
      `[bot] gh api failed for ${repo} comment ${commentId}: ${stderr.trim() || `exit ${exitCode}`}`,
    );
    return null;
  }
  try {
    const data = (await new Response(proc.stdout).json()) as {
      user?: { login?: string };
      body?: string;
    };
    return { author: data.user?.login ?? '', body: data.body ?? '' };
  } catch {
    return null;
  }
}

// Act only on replies by an allowed actor under one of the bot's own inline
// simplification ideas. pr-review also posts bot-authored inline comments, so
// authorship alone is not enough — the root must carry the simplify marker.
async function isReplyActionable(
  event: PullRequestReviewCommentEvent,
): Promise<boolean> {
  if (event.action !== 'created') return false;
  // Never act on the bot's own replies, even if botLogin is in allowedActors.
  if (event.sender.login === botLogin) return false;
  if (event.pull_request.draft) return false;
  if (!config.allowedActors.includes(event.sender.login)) return false;
  if (event.pull_request.head.repo?.full_name !== event.repository.full_name) {
    return false;
  }
  const rootId = event.comment.in_reply_to_id;
  if (rootId === undefined) return false;
  const root = await reviewComment(event.repository.full_name, rootId);
  if (root === null) return false;
  return root.author === botLogin && root.body.includes(SIMPLIFY_IDEA_MARKER);
}

const prTrigger = ghReceiver.pullRequest({
  actions: ['opened', 'synchronize', 'reopened', 'ready_for_review'],
});

prReviewAgent.on(prTrigger, async (event) => {
  if (!(await isEventActionable(event))) return;
  const tag = `${event.repository.full_name}#${event.number}`;
  console.log(`[bot] dispatch pr-review ${tag} action=${event.action}`);
  await handlePrReview(prReviewAgent, event);
});

docsUpdateAgent.on(prTrigger, async (event) => {
  if (!(await isEventActionable(event))) return;
  const tag = `${event.repository.full_name}#${event.number}`;
  console.log(`[bot] dispatch docs-update ${tag} action=${event.action}`);
  await handleDocsUpdate(docsUpdateAgent, event, config);
});

const simplifyIdeasTrigger = ghReceiver.pullRequest({
  actions: ['opened', 'ready_for_review'],
});
const reviewCommentTrigger = ghReceiver.pullRequestReviewComment({
  actions: ['created'],
});

simplifyAgent.on(simplifyIdeasTrigger, async (event) => {
  if (!(await isEventActionable(event))) return;
  const tag = `${event.repository.full_name}#${event.number}`;
  console.log(`[bot] dispatch simplify-ideas ${tag} action=${event.action}`);
  await handleSimplifyIdeas(simplifyAgent, event);
});

simplifyAgent.on(reviewCommentTrigger, async (event) => {
  if (!(await isReplyActionable(event))) return;
  const tag = `${event.repository.full_name}#${event.pull_request.number}`;
  console.log(
    `[bot] dispatch simplify-apply ${tag} comment=${event.comment.id}`,
  );
  await handleSimplifyReply(simplifyAgent, event, config);
});

const dxAuditTrigger = ghReceiver.pullRequest({
  actions: ['opened', 'ready_for_review'],
});

dxAuditAgent.on(dxAuditTrigger, async (event) => {
  if (!(await isEventActionable(event))) return;
  const tag = `${event.repository.full_name}#${event.number}`;
  console.log(`[bot] dispatch dx-audit ${tag} action=${event.action}`);
  await handleDxAudit(dxAuditAgent, event);
});

await prReviewAgent.start();
await docsUpdateAgent.start();
await simplifyAgent.start();
await dxAuditAgent.start();

const app = new Hono();
app.get('/', (c) => c.text('ok'));
app.post('/webhooks/github', async (c) => {
  // Keep GH_TOKEN fresh before handlers (and their gh/git calls) run; no-op
  // until the installation token nears expiry.
  await githubApp.syncToken();
  return ghReceiver.handle(c.req.raw);
});

console.log(`[bot] listening on :${config.port}`);
Bun.serve({ port: config.port, fetch: app.fetch });
