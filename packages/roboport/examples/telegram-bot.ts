import { join } from 'node:path';

import { fileStore, serve, stream, telegramChannel } from '@/channels';
import { Agent } from '@/core';
import { claudeCode } from '@/harness';
import { Anthropic } from '@/models';

// A personal Telegram assistant: per-chat memory, a persona it maintains itself,
// a bounded context window, and streamed replies. A trimmed-down take on a real
// always-on agent you talk to from your phone. Replies are sent as rich
// messages, so the agent's Markdown renders with headings, lists, and code.
const token = process.env.TELEGRAM_TOKEN;
if (!token) throw new Error('TELEGRAM_TOKEN is required');

const workspace = process.env.ASSISTANT_WORKSPACE ?? './workspace';
const ownerIds = (process.env.ALLOWED_USER_IDS ?? '')
  .split(',')
  .filter(Boolean);

const agent = new Agent({
  model: new Anthropic('claude-opus-4-8', { thinking: 'medium' }),
  system: claudeCode.system,
  tools: claudeCode.tools,
  skills: [],
  cwd: workspace, // the agent's home — its file tools read/write here
});

const bot = serve(agent, telegramChannel({ token }), {
  authorize: (message) => ownerIds.includes(message.user?.id ?? ''),
  // Standing instructions the agent edits over time, injected each turn.
  systemExtension: async () => {
    const file = Bun.file(join(workspace, 'AGENTS.md'));
    return (await file.exists()) ? await file.text() : '';
  },
  context: (stored) => stored.slice(-40),
  relay: stream(),
  store: fileStore(join(workspace, 'history')),
});

process.on('SIGINT', () => void bot.stop());
