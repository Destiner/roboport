# Roboport

> Agents as Code

A minimal framework for building agents.

Composable primitives with sane defaults. Bring your own models, tools, skills; or just use the built-ins.

- **Minimal**: zero dependencies, small core
- **High level**: no tool approvals, no steering
- **Modular**: swap out built-in components or implement custom ones
- **Batteries included** — harness presets, a built-in skill bundle, and MCP client support

## Example

```ts
import { Agent } from 'roboport';
import { claudeCode } from 'roboport/harness';
import { AnthropicModel } from 'roboport/models';
import { prReview } from 'roboport/skills';
import { github } from 'roboport/triggers';

const agent = new Agent({
  model: new AnthropicModel('claude-opus-4-8', { thinking: 'medium' }),
  prompt: claudeCode.system,
  tools: claudeCode.tools,
  skills: [prReview],
});

const gh = github({ secret: process.env.GITHUB_WEBHOOK_SECRET });
agent.on(
  gh.pullRequest({ actions: ['opened', 'synchronize'] }),
  async (event) => {
    await using session = agent.session();
    await session.send(
      `Review PR #${event.number} in ${event.repository.full_name}. ` +
        `Post the verdict and any line-level findings to GitHub.`,
    );
  },
);

await agent.start();
```

## Sessions

`agent.session()` returns a `Session` you can stream from and reuse across turns.

```ts
await using session = agent.session();

// Stream events as they arrive
for await (const event of session.send('Summarise the branch.')) {
  if (event.type === 'text-delta') process.stdout.write(event.text);
  if (event.type === 'tool-call') console.log(`→ ${event.toolName}`);
  if (event.type === 'tool-result') console.log(`← ${event.toolName}`);
}

// Or await the turn for the post-turn message history
const messages = await session.send('Now write a PR description.');
```

Resume a prior conversation by passing its message history:

```ts
const resumed = agent.session({ messages: savedMessages });
await resumed.send('Continue from here.');
```

Sessions hold MCP connections for their lifetime, so close them when done (or use `await using`).

## Skills

```ts
import { Skill } from 'roboport';
import { prReview, docsUpdate } from 'roboport/skills';

const releaseNotes = new Skill({
  name: 'release-notes',
  description: 'Draft release notes from merged PRs.',
  content: '# Release notes\n\n...',
});

const agent = new Agent({
  // …
  skills: [docsUpdate, releaseNotes],
});
```

Skills are lazy-loaded by the model.

## MCP

```ts
import { Grafana, Linear } from 'roboport/mcp';

const agent = new Agent({
  // …
  mcp: [
    new Grafana({
      url: process.env.GRAFANA_URL,
      serviceAccountToken: process.env.GRAFANA_TOKEN,
    }),
    new Linear({ apiKey: process.env.LINEAR_API_KEY }),
  ],
});
```

MCP tools are deferred by default and surfaced via `ToolSearch`.

## Triggers

A trigger is an event source. The handler decides whether to start the agent.

```ts
import { cron, github } from 'roboport/triggers';

// Time-based, fires in-process
agent.on(cron({ schedule: { every: 'day', at: { hour: 9 } } }), async () => {
  await using session = agent.session();
  await session.send('Post the daily standup summary.');
});

// Webhook-based
const gh = github({ secret: process.env.GITHUB_WEBHOOK_SECRET });
agent.on(gh.pullRequest({ actions: ['opened'] }), async (event) => {
  await using session = agent.session();
  await session.send(`Review PR #${event.number}.`);
});

await agent.start();
```

A webhook trigger needs a URL to receive events. Bind the receiver's `handle` to a route:

```ts
app.post('/webhooks/github', (c) => gh.handle(c.req.raw));
```

## Status

Early. Experimental. APIs will change.
