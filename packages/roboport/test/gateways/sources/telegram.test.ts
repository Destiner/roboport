import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import type { Turn } from '@/core';
import {
  stream,
  telegramGateway,
  type InboundMessage,
  type TelegramChannel,
} from '@/gateways';
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

describe('telegramGateway (webhook)', () => {
  test('maps an inbound update onto an InboundMessage', async () => {
    const gateway = telegramGateway({
      token: 't',
      transport: { mode: 'webhook', secretToken: SECRET },
    });
    const received: InboundMessage[] = [];
    await gateway.open((message) => {
      received.push(message);
    });

    await gateway.handle!(
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

describe('TelegramChannel', () => {
  afterEach(() => {
    spyOn(globalThis, 'fetch').mockRestore();
  });

  async function captureChannel(
    overrides: Partial<TelegramMessage> = {},
  ): Promise<TelegramChannel> {
    const gateway = telegramGateway({
      token: 't',
      transport: { mode: 'webhook', secretToken: SECRET },
    });
    let channel: TelegramChannel | null = null;
    await gateway.open((_message, ch) => {
      channel = ch;
    });
    await gateway.handle!(
      makeRequest({ update_id: 1, message: privateMessage(overrides) }),
    );
    if (!channel) throw new Error('channel was not delivered');
    return channel;
  }

  test('send relays through the client sendMessage API', async () => {
    const channel = await captureChannel();
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

    await channel.send('reply');
    expect(body).toMatchObject({ chat_id: 42, text: 'reply' });
  });

  test('keys per forum topic and routes replies back to it', async () => {
    const channel = await captureChannel({ message_thread_id: 9 });
    expect(channel.conversationId).toBe('42:9');

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

    await channel.send('reply');
    expect(body).toMatchObject({
      chat_id: 42,
      text: 'reply',
      message_thread_id: 9,
    });
  });

  test('draft relays through the client sendMessageDraft API', async () => {
    const channel = await captureChannel();
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

    await channel.draft('partial');
    expect(body).toMatchObject({ chat_id: 42, draft_id: 1, text: 'partial' });
  });
});

describe('stream relay', () => {
  const message: InboundMessage = { id: '1', conversationId: '1', text: '' };

  function captureChannel(): {
    channel: TelegramChannel;
    sent: string[];
    drafts: string[];
  } {
    const sent: string[] = [];
    const drafts: string[] = [];
    const channel: TelegramChannel = {
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
    return { channel, sent, drafts };
  }

  test('commits the assembled reply with sendMessage', async () => {
    const { channel, sent } = captureChannel();
    const turn = fakeTurn([
      { type: 'text-delta', text: 'Hel' },
      { type: 'text-delta', text: 'lo' },
      { type: 'text', text: 'Hello' },
    ]) as unknown as Turn;

    await stream({ throttleMs: 0 })(turn, channel, message);
    expect(sent).toEqual(['Hello']);
  });

  test('rethrows a turn error when nothing was produced', async () => {
    const { channel } = captureChannel();
    const turn = fakeTurn([
      { type: 'error', error: new Error('model exploded') },
    ]) as unknown as Turn;

    await expect(stream()(turn, channel, message)).rejects.toThrow(
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
