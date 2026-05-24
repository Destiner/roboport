# Drone

> Agents as Code

Minimal framework for building agents.

Composable primitives with sane defaults. Bring your own models, tools, skills; or just use the built-ins.

```ts
import { Agent, Skill } from 'drone';
import { claudeCode } from 'drone/harness';
import { Grafana, Linear } from 'drone/mcp';
import { AnthropicModel } from 'drone/models';
import { grafanaTrigger } from 'drone/triggers';

const incidentTriage = new Skill({
  name: 'incident-triage',
  description: 'Investigate a Grafana alert and open a Linear triage ticket.',
  content: '...', // playbook lives here
});

const agent = new Agent({
  model: new AnthropicModel('claude-sonnet-4-6'),
  prompt: 'You are an on-call triage agent.',
  tools: claudeCode.tools,
  skills: [incidentTriage],
  mcp: [
    new Grafana({
      url: process.env.GRAFANA_URL!,
      serviceAccountToken: process.env.GRAFANA_TOKEN!,
    }),
    new Linear({ apiKey: process.env.LINEAR_API_KEY! }),
  ],
});

const grafana = grafanaTrigger();
agent.on(grafana.alert({ status: 'firing' }), {
  prompt: (alert) =>
    `Triage alert "${alert.labels.alertname}" and file a Linear ticket. Use the ${incidentTriage.name} skill.`,
});

await agent.start();

// Mount the Grafana receiver on your HTTP server of choice
Bun.serve({ port: 8080, fetch: (req) => grafana.handle(req) });
```

## Scripts

```sh
bun install
bun run check
bun run typecheck
```

## Models

`OpenAIModel` uses `OPENAI_API_KEY` by default. You can also pass `auth: { type: 'apiKey', apiKey }`.

```ts
import { OpenAIModel } from 'drone/models';

const model = new OpenAIModel('gpt-5.4-mini', {
  auth: { type: 'apiKey', apiKey: process.env.OPENAI_API_KEY },
});
```

To reuse ChatGPT OAuth tokens from `codex login`, pass Codex auth:

```ts
const model = new OpenAIModel('gpt-5.3-codex', {
  auth: { type: 'codex' },
});
```

Codex auth checks `DRONE_OPENAI_CODEX_AUTH_FILE`, then `CODEX_HOME/auth.json`, `~/.codex/auth.json`, and `~/.drone/openai-codex-auth.json`.

## Status

Early. Experimental. APIs will change.
