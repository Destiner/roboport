# Drone

> Agents as Code

Minimal framework for building agents.

Composable primitives with sane defaults. Bring your own models, tools, skills; or just use the built-ins.

```ts
import { Agent, Skill } from '@/core';
import { claudeCode } from '@/harness';
import { AnthropicModel } from '@/models';
import { grafanaMcp, linearMcp } from '@/mcp';

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
    grafanaMcp({
      url: process.env.GRAFANA_URL!,
      serviceAccountToken: process.env.GRAFANA_TOKEN!,
    }),
    linearMcp({ apiKey: process.env.LINEAR_API_KEY! }),
  ],
});

agent.on('grafana:alert', (alert) => {
  if (alert.isResolved) return;
  agent.createSession({
    prompt: `Triage Grafana alert ${alert.id} and file a Linear ticket. Use the ${incidentTriage.name} skill.`,
  });
});
```

## Scripts

```sh
bun install
bun run lint
bun run typecheck
```

## Status

Early. Experimental. APIs will change.
