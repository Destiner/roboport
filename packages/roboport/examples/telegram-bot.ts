import { Agent } from '@/core';
import { serve, telegramGateway } from '@/gateways';
import { claudeCode } from '@/harness';
import { AnthropicModel } from '@/models';

const token = process.env.TELEGRAM_TOKEN;
if (!token) throw new Error('TELEGRAM_TOKEN is required');

const agent = new Agent({
  model: new AnthropicModel('claude-opus-4-7'),
  system: claudeCode.system,
  tools: claudeCode.tools,
  skills: [],
});

// Long-polling by default: no public URL, in-memory history per chat, one reply
// per turn, a "typing…" indicator while the agent works. That's the whole bot.
const bot = serve(agent, telegramGateway({ token }));

process.on('SIGINT', () => void bot.stop());
