import { Agent } from '@/core';
import { claudeCode } from '@/harness';
import { AnthropicModel } from '@/models';
import { codeSimplifier } from '@/skills';

import { logMessages } from './common';

const agent = new Agent({
  model: new AnthropicModel('claude-opus-4-7'),
  prompt: claudeCode.system,
  tools: claudeCode.tools,
  skills: [codeSimplifier],
});

const session = await agent.createSession({
  prompt: 'Summarise the changes on the current branch.',
});

logMessages(session.messages);
