import { Agent } from '@/core';
import { codex } from '@/harness';
import { OpenAIModel } from '@/models';
import { prReview } from '@/skills';

import { logMessages } from './common';

const agent = new Agent({
  model: new OpenAIModel('gpt-5.5', { thinking: 'high' }),
  prompt: codex.system,
  tools: codex.tools,
  skills: [prReview],
});

const session = await agent.createSession({
  prompt: 'Review the current branch.',
});

logMessages(session.messages);
