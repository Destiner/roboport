import { Agent } from '@/core';
import { codex } from '@/harness';
import { OpenAIModel } from '@/models';
import { prReview } from '@/skills';

const agent = new Agent({
  model: new OpenAIModel('gpt-5.5'),
  prompt: codex.system,
  tools: codex.tools,
  skills: [prReview],
});

const session = await agent.createSession({
  prompt: 'Review the current branch.',
});

for (const message of session.messages) {
  if (message.role === 'system') continue;

  if (message.role === 'user') {
    const text =
      typeof message.content === 'string'
        ? message.content
        : message.content.map((part) => part.text).join('');
    console.log(`[user] ${text}`);
    continue;
  }

  if (message.role === 'assistant') {
    for (const part of message.content) {
      if (part.type === 'text') {
        console.log(`[assistant] ${part.text}`);
      } else {
        console.log(
          `[assistant:tool-call] ${part.toolName}(${JSON.stringify(part.input)})`,
        );
      }
    }
    continue;
  }

  for (const part of message.content) {
    console.log(
      `[tool-result] ${part.toolName} -> ${JSON.stringify(part.output)}`,
    );
  }
}
