import { z } from 'zod';

import { Agent, Model, Tool, type ThinkingLevel } from '@/core';
import {
  AnthropicModel,
  GeminiModel,
  MoonshotModel,
  OpenAIModel,
} from '@/models';

const addTool = new Tool({
  name: 'add',
  description: 'Add two integers and return the sum.',
  inputSchema: z.object({ a: z.number(), b: z.number() }),
  execute: ({ a, b }): number => a + b,
});

async function run(label: string, agent: Agent): Promise<void> {
  console.log(`\n=== ${label} ===`);
  const session = await agent.createSession({
    prompt:
      'Use the `add` tool to compute 47 + 58. Then state the final answer in one sentence.',
  });
  for (const msg of session.messages) {
    if (msg.role !== 'assistant') continue;
    for (const part of msg.content) {
      if (part.type === 'thinking') {
        const preview = part.text.slice(0, 120).replace(/\n/g, ' ');
        console.log(
          `  [thinking ${part.text.length}c sig=${part.signature ? 'y' : 'n'}] ${preview}`,
        );
      } else if (part.type === 'text') {
        console.log(`  [text] ${part.text.slice(0, 200)}`);
      } else if (part.type === 'tool-call') {
        console.log(
          `  [tool-call] ${part.toolName}(${JSON.stringify(part.input)})`,
        );
      }
    }
  }
}

const matrix: { label: string; build: (level: ThinkingLevel) => Model }[] = [
  {
    label: 'Anthropic claude-haiku-4-5',
    build: (level) =>
      new AnthropicModel('claude-haiku-4-5', { thinking: level }),
  },
  {
    label: 'OpenAI gpt-5.3-codex (codex auth)',
    build: (level) =>
      new OpenAIModel('gpt-5.3-codex', {
        auth: { type: 'codex' },
        thinking: level,
      }),
  },
  {
    label: 'Gemini gemini-2.5-flash',
    build: (level) => new GeminiModel('gemini-2.5-flash', { thinking: level }),
  },
  {
    label: 'Moonshot kimi-k2.6',
    build: (level) => new MoonshotModel('kimi-k2.6', { thinking: level }),
  },
];

const levels: ThinkingLevel[] = ['off', 'low'];
for (const { label, build } of matrix) {
  for (const level of levels) {
    try {
      await run(
        `${label} thinking=${level}`,
        new Agent({
          model: build(level),
          prompt:
            'You are a calculator. Use tools when arithmetic is involved.',
          tools: [addTool],
          skills: [],
        }),
      );
    } catch (err) {
      console.log(`  [error] ${err instanceof Error ? err.message : err}`);
    }
  }
}
