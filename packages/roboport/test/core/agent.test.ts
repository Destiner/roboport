import { describe, expect, test } from 'bun:test';

import {
  Agent,
  Model,
  type CreateMessageParams,
  type Message,
  type ModelStreamEvent,
  type SearchHit,
} from '@/core';

class CaptureModel extends Model {
  lastMessages: Message[] = [];

  async *streamMessage(
    params: CreateMessageParams,
  ): AsyncIterable<ModelStreamEvent> {
    this.lastMessages = params.messages;
    yield { type: 'text-end', text: 'ok' };
    yield {
      type: 'message-end',
      id: '1',
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  async searchWeb(): Promise<SearchHit[]> {
    return [];
  }
}

describe('Agent.session', () => {
  test('applies systemExtension even when seeded history starts with a system message', async () => {
    const model = new CaptureModel();
    const agent = new Agent({ model, system: 'CORE', tools: [], skills: [] });

    const session = agent.session({
      messages: [
        { role: 'system', content: 'CORE\n\nOLD' },
        { role: 'user', content: 'hi' },
      ],
      systemExtension: 'NEW',
    });
    await session.send('again');
    await session.close();

    const system = model.lastMessages[0];
    expect(system?.role).toBe('system');
    expect(system?.content).toContain('NEW');
    expect(system?.content).not.toContain('OLD');
    expect(model.lastMessages.filter((m) => m.role === 'system')).toHaveLength(
      1,
    );
  });
});
