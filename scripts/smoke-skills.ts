import { Agent, Skill, type Model } from '@/core';
import type { ToolCallPart } from '@/message';
import { AnthropicModel, MoonshotModel, OpenAIModel } from '@/models';

const triage = new Skill({
  name: 'triage',
  description: 'Steps for triaging a production incident.',
  content:
    'When triaging an incident: (1) check Grafana for the failing service, (2) page the owner listed in PagerDuty, (3) file a Linear ticket tagged "incident".',
});

const userPrompt =
  'A new alert just fired. Use the triage skill to figure out the procedure, then summarize the steps back to me.';

interface ProviderConfig {
  name: string;
  envKey: string;
  modelEnv: string;
  defaultModel: string;
  factory: (modelName: string) => Model;
}

const providers: ProviderConfig[] = [
  {
    name: 'anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    modelEnv: 'DRONE_ANTHROPIC_MODEL',
    defaultModel: 'claude-haiku-4-5-20251001',
    factory: (m): Model => new AnthropicModel(m),
  },
  {
    name: 'openai',
    envKey: 'OPENAI_API_KEY',
    modelEnv: 'DRONE_OPENAI_MODEL',
    defaultModel: 'gpt-5-mini',
    factory: (m): Model => new OpenAIModel(m),
  },
  {
    name: 'moonshot',
    envKey: 'MOONSHOT_API_KEY',
    modelEnv: 'DRONE_MOONSHOT_MODEL',
    defaultModel: 'kimi-k2.6',
    factory: (m): Model => new MoonshotModel(m),
  },
];

async function runOne(p: ProviderConfig): Promise<void> {
  if (!process.env[p.envKey]) {
    console.log(`[${p.name}] skipped (${p.envKey} not set)`);
    return;
  }
  const modelName = process.env[p.modelEnv] ?? p.defaultModel;
  let model: Model;
  try {
    model = p.factory(modelName);
  } catch (err) {
    console.log(
      `[${p.name}] ${modelName} → ERROR constructing model: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  const agent = new Agent({
    model,
    prompt: 'You are an on-call agent.',
    tools: [],
    skills: [triage],
  });

  try {
    const session = await agent.createSession({ prompt: userPrompt });
    const skillCalls: ToolCallPart[] = [];
    for (const msg of session.messages) {
      if (msg.role !== 'assistant') continue;
      for (const part of msg.content) {
        if (part.type === 'tool-call' && part.toolName === 'Skill') {
          skillCalls.push(part);
        }
      }
    }
    const pass = skillCalls.length > 0;
    console.log(
      `[${p.name}] ${modelName} → ${pass ? 'PASS' : 'FAIL'} (${skillCalls.length} Skill call${skillCalls.length === 1 ? '' : 's'}, ${session.messages.length} msgs)`,
    );
    const firstCall = skillCalls[0];
    if (firstCall) {
      console.log(`           input: ${JSON.stringify(firstCall.input)}`);
    }
  } catch (err) {
    console.log(
      `[${p.name}] ${modelName} → ERROR: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

for (const p of providers) {
  await runOne(p);
}
