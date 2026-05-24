import { Agent } from '@/core';
import { claudeCode } from '@/harness';
import { AnthropicModel } from '@/models';
import { codeSimplifier } from '@/skills';

const agent = new Agent({
  model: new AnthropicModel('claude-opus-4-7'),
  prompt: claudeCode.system,
  tools: claudeCode.tools,
  skills: [codeSimplifier],
});

const prompt =
  process.argv.slice(2).join(' ').trim() ||
  'Summarise the changes on the current branch.';

const session = await agent.createSession({ prompt });

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
