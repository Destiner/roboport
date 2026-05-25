import { githubTrigger, type PullRequestEvent } from 'drone/triggers';
import { Hono } from 'hono';

import { loadConfig } from './config';
import {
  createDocsUpdateAgent,
  handleDocsUpdate,
} from './workflows/docs-update';
import { createPrReviewAgent, handlePrReview } from './workflows/pr-review';

const config = loadConfig();

const ghAuthSetup = Bun.spawnSync([
  'gh',
  'auth',
  'setup-git',
  '--hostname',
  'github.com',
]);
if (ghAuthSetup.exitCode !== 0) {
  const stderr = new TextDecoder().decode(ghAuthSetup.stderr);
  throw new Error(`gh auth setup-git failed: ${stderr}`);
}

const ghReceiver = githubTrigger({ secret: config.webhookSecret });

const prReviewAgent = createPrReviewAgent(config);
const docsUpdateAgent = createDocsUpdateAgent(config);

function isEventActionable(event: PullRequestEvent): boolean {
  if (event.pull_request.draft) return false;
  if (!config.allowedActors.includes(event.sender.login)) return false;
  if (event.pull_request.head.repo?.full_name !== event.repository.full_name) {
    return false;
  }
  return true;
}

const prTrigger = ghReceiver.pullRequest({
  actions: ['opened', 'synchronize', 'reopened', 'ready_for_review'],
});

prReviewAgent.on(prTrigger, async (event) => {
  if (!isEventActionable(event)) return;
  const tag = `${event.repository.full_name}#${event.number}`;
  console.log(`[bot] dispatch pr-review ${tag} action=${event.action}`);
  await handlePrReview(prReviewAgent, event);
});

docsUpdateAgent.on(prTrigger, async (event) => {
  if (!isEventActionable(event)) return;
  const tag = `${event.repository.full_name}#${event.number}`;
  console.log(`[bot] dispatch docs-update ${tag} action=${event.action}`);
  await handleDocsUpdate(docsUpdateAgent, event, config);
});

await prReviewAgent.start();
await docsUpdateAgent.start();

const app = new Hono();
app.get('/', (c) => c.text('ok'));
app.post('/webhooks/github', (c) => ghReceiver.handle(c.req.raw));

console.log(`[bot] listening on :${config.port}`);
Bun.serve({ port: config.port, fetch: app.fetch });
