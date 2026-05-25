import { Agent } from '@/core';
import { claudeCode } from '@/harness';
import { AnthropicModel } from '@/models';
import { codeSimplifier } from '@/skills';

import { logEvents, logMessages } from './common';

const agent = new Agent({
  model: new AnthropicModel('claude-opus-4-7'),
  prompt: claudeCode.system,
  tools: claudeCode.tools,
  skills: [codeSimplifier],
});

await using session = agent.session();

await logEvents(session.send('Summarise the changes on the current branch.'));
logMessages([...session.messages]);
