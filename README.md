# Roboport

> Agents as Code

Minimal framework for building agents.

Composable primitives with sane defaults. Bring your own models, tools, skills; or just use the built-ins.

```ts
import { Agent } from 'roboport';
import { claudeCode } from 'roboport/harness';
import { AnthropicModel } from 'roboport/models';
import { prReview } from 'roboport/skills';
import { githubTrigger } from 'roboport/triggers';

const agent = new Agent({
  model: new AnthropicModel('claude-opus-4-8', { thinking: 'medium' }),
  prompt: `You are a code review agent. Apply the ${prReview.name} skill.`,
  tools: claudeCode.tools,
  skills: [prReview],
});

const github = githubTrigger({ secret: process.env.GITHUB_WEBHOOK_SECRET });
agent.on(
  github.pullRequest({ actions: ['opened', 'synchronize'] }),
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

Event types include `text-delta`, `text`, `thinking-delta`, `thinking`, `tool-call`, `tool-result`, `message-start`, `message-end`, `turn-end`, and `error`. Token-level deltas stream as the model emits them; matching completion events fire once each block is fully assembled.

Resume a prior conversation by passing its message history:

```ts
const resumed = agent.session({ messages: savedMessages });
await resumed.send('Continue from here.');
```

Sessions hold MCP connections for their lifetime, so close them when done (or use `await using`).

## Model thinking

Model adapters that support reasoning can opt in with a shared `thinking` option:

```ts
new AnthropicModel('claude-sonnet-4-6', { thinking: 'low' });
```

Levels are `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`. Provider adapters map supported levels to their wire formats; unsupported levels may be collapsed, ignored, or rejected by the provider. When a provider returns reasoning content, assistant messages include `thinking` parts alongside text and tool calls.

## Status

Early. Experimental. APIs will change.
