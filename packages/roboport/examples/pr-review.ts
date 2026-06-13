import { Agent } from '@/core';
import { codex } from '@/harness';
import { OpenAI } from '@/models';
import { prReview } from '@/skills';

import { logEvents, logMessages } from './common';

const agent = new Agent({
  model: new OpenAI('gpt-5.5', { thinking: 'high' }),
  system: codex.system,
  tools: codex.tools,
  skills: [prReview],
});

await using session = agent.session();

await logEvents(session.send('Review the current branch.'));
logMessages([...session.messages]);
