import { Agent } from '@/core';
import { claudeCode } from '@/harness';
import { Anthropic } from '@/models';
import { codeSimplifier } from '@/skills';

import { logEvents, logMessages } from './common';

const agent = new Agent({
  model: new Anthropic('claude-opus-4-7'),
  system: claudeCode.system,
  tools: claudeCode.tools,
  skills: [codeSimplifier],
});

await using session = agent.session();

await logEvents(session.send('Summarise the changes on the current branch.'));
logMessages([...session.messages]);
