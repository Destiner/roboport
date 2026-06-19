import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import {
  stream,
  telegramChannel,
  type InboundMessage,
  type TelegramConversation,
} from '@/channels';
import type { Turn } from '@/core';
import {
  TelegramClient,
  type TelegramMessage,
} from '@/triggers/sources/telegram';

const SECRET = 'topsecret';

function makeRequest(update: unknown): Request {
  return new Request('https://example.com/webhooks/telegram', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': SECRET,
    },
    body: JSON.stringify(update),
  });
}

function privateMessage(
  overrides: Partial<TelegramMessage> = {},
): TelegramMessage {
  return {
    message_id: 1,
    from: { id: 42, is_bot: false, first_name: 'Tim', username: 'Tim' },
    chat: { id: 42, type: 'private' },
    date: 0,
    text: 'hello',
    ...overrides,
  };
}

async function* fakeTurn(events: unknown[]): AsyncGenerator<unknown> {
  for (const event of events) yield event;
}

describe('telegramChannel (webhook)', () => {
  test('maps an inbound update onto an InboundMessage', async () => {
    const channel = telegramChannel({
      token: 't',
      transport: { mode: 'webhook', secretToken: SECRET },
    });
    const received: InboundMessage[] = [];
    await channel.open((message) => {
      received.push(message);
    });

    await channel.handle!(
      makeRequest({ update_id: 1, message: privateMessage() }),
    );

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      id: '1',
      conversationId: '42',
      text: 'hello',
      user: { id: '42', name: 'Tim' },
    });
  });
});

describe('TelegramConversation', () => {
  afterEach(() => {
    spyOn(globalThis, 'fetch').mockRestore();
  });

  async function captureConversation(
    overrides: Partial<TelegramMessage> = {},
  ): Promise<TelegramConversation> {
    const channel = telegramChannel({
      token: 't',
      transport: { mode: 'webhook', secretToken: SECRET },
    });
    let conversation: TelegramConversation | null = null;
    await channel.open((_message, conv) => {
      conversation = conv;
    });
    await channel.handle!(
      makeRequest({ update_id: 1, message: privateMessage(overrides) }),
    );
    if (!conversation) throw new Error('conversation was not delivered');
    return conversation;
  }

  test('send relays through the client sendRichMessage API', async () => {
    const conversation = await captureConversation();
    let body: Record<string, unknown> = {};
    spyOn(globalThis, 'fetch').mockImplementation((async (
      _url: string,
      init: RequestInit,
    ) => {
      body = JSON.parse(init.body as string) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 2 } }),
        { headers: { 'content-type': 'application/json' } },
      );
    }) as never);

    await conversation.send('reply');
    expect(body).toMatchObject({
      chat_id: 42,
      rich_message: { markdown: 'reply' },
    });
  });

  test('keys per forum topic and routes replies back to it', async () => {
    const conversation = await captureConversation({ message_thread_id: 9 });
    expect(conversation.conversationId).toBe('42:9');

    let body: Record<string, unknown> = {};
    spyOn(globalThis, 'fetch').mockImplementation((async (
      _url: string,
      init: RequestInit,
    ) => {
      body = JSON.parse(init.body as string) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 2 } }),
        { headers: { 'content-type': 'application/json' } },
      );
    }) as never);

    await conversation.send('reply');
    expect(body).toMatchObject({
      chat_id: 42,
      rich_message: { markdown: 'reply' },
      message_thread_id: 9,
    });
  });

  test('draft relays through the client sendRichMessageDraft API', async () => {
    const conversation = await captureConversation();
    let body: Record<string, unknown> = {};
    spyOn(globalThis, 'fetch').mockImplementation((async (
      _url: string,
      init: RequestInit,
    ) => {
      body = JSON.parse(init.body as string) as Record<string, unknown>;
      return new Response(JSON.stringify({ ok: true, result: true }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as never);

    await conversation.draft('partial');
    expect(body).toMatchObject({
      chat_id: 42,
      draft_id: 1,
      rich_message: { markdown: 'partial' },
    });
  });
});

describe('stream relay', () => {
  const message: InboundMessage = { id: '1', conversationId: '1', text: '' };

  function captureConversation(): {
    conversation: TelegramConversation;
    sent: string[];
    drafts: string[];
  } {
    const sent: string[] = [];
    const drafts: string[] = [];
    const conversation: TelegramConversation = {
      conversationId: '1',
      chatId: 1,
      client: {} as TelegramClient,
      send: async (text: string): Promise<void> => {
        sent.push(text);
      },
      draft: async (text: string): Promise<void> => {
        drafts.push(text);
      },
    };
    return { conversation, sent, drafts };
  }

  test('commits the assembled reply with sendMessage', async () => {
    const { conversation, sent } = captureConversation();
    const turn = fakeTurn([
      { type: 'text-delta', text: 'Hel' },
      { type: 'text-delta', text: 'lo' },
      { type: 'text', text: 'Hello' },
    ]) as unknown as Turn;

    await stream({ throttleMs: 0 })(turn, conversation, message);
    expect(sent).toEqual(['Hello']);
  });

  test('rethrows a turn error when nothing was produced', async () => {
    const { conversation } = captureConversation();
    const turn = fakeTurn([
      { type: 'error', error: new Error('model exploded') },
    ]) as unknown as Turn;

    await expect(stream()(turn, conversation, message)).rejects.toThrow(
      'model exploded',
    );
  });
});

describe('TelegramClient.getUpdates', () => {
  afterEach(() => {
    spyOn(globalThis, 'fetch').mockRestore();
  });

  test('forwards offset, timeout, and allowed_updates', async () => {
    let url = '';
    let body: Record<string, unknown> = {};
    spyOn(globalThis, 'fetch').mockImplementation((async (
      requestUrl: string,
      init: RequestInit,
    ) => {
      url = requestUrl;
      body = JSON.parse(init.body as string) as Record<string, unknown>;
      return new Response(JSON.stringify({ ok: true, result: [] }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as never);

    const client = new TelegramClient('token');
    const updates = await client.getUpdates({
      offset: 5,
      timeout: 25,
      allowedUpdates: ['message'],
    });

    expect(updates).toEqual([]);
    expect(url).toContain('/bottoken/getUpdates');
    expect(body).toMatchObject({
      offset: 5,
      timeout: 25,
      allowed_updates: ['message'],
    });
  });
});
