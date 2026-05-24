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
  model: new AnthropicModel('claude-opus-4-7', { thinking: 'low' }),
  prompt: 'You are an on-call triage agent.',
  tools: claudeCode.tools,
  skills: [incidentTriage],
  mcp: [
    new Grafana({
      url: process.env.GRAFANA_URL,
      serviceAccountToken: process.env.GRAFANA_TOKEN,
    }),
    new Linear({ apiKey: process.env.LINEAR_API_KEY }),
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

## Model thinking

Model adapters that support reasoning can opt in with a shared `thinking` option:

```ts
new AnthropicModel('claude-sonnet-4-6', { thinking: 'low' });
```

Levels are `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`. Provider adapters map supported levels to their wire formats; unsupported levels may be collapsed, ignored, or rejected by the provider. When a provider returns reasoning content, assistant messages include `thinking` parts alongside text and tool calls.

## Status

Early. Experimental. APIs will change.
