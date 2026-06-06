import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import {
  splitMessage,
  TelegramClient,
  telegramTrigger,
  type TelegramMessage,
} from '@/triggers/sources/telegram';

const SECRET = 'topsecret';

function makeRequest(update: unknown, secret: string | null = SECRET): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (secret !== null) headers['x-telegram-bot-api-secret-token'] = secret;
  return new Request('https://example.com/webhooks/telegram', {
    method: 'POST',
    headers,
    body: JSON.stringify(update),
  });
}

function privateMessage(
  overrides: Partial<TelegramMessage> = {},
): TelegramMessage {
  return {
    message_id: 1,
    from: { id: 42, is_bot: false, first_name: 'Tim' },
    chat: { id: 42, type: 'private' },
    date: 0,
    text: 'hello',
    ...overrides,
  };
}

describe('TelegramReceiver.handle', () => {
  test('dispatches message updates when the secret matches', async () => {
    const receiver = telegramTrigger({ secretToken: SECRET });
    const events: TelegramMessage[] = [];
    receiver.message().start((m) => events.push(m));

    const res = await receiver.handle(
      makeRequest({ update_id: 1, message: privateMessage() }),
    );

    expect(res.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]?.text).toBe('hello');
  });

  test('rejects a missing or wrong secret token without dispatching', async () => {
    const receiver = telegramTrigger({ secretToken: SECRET });
    const events: TelegramMessage[] = [];
    receiver.message().start((m) => events.push(m));

    const missing = await receiver.handle(
      makeRequest({ update_id: 1, message: privateMessage() }, null),
    );
    const wrong = await receiver.handle(
      makeRequest({ update_id: 2, message: privateMessage() }, 'nope'),
    );

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(events).toHaveLength(0);
  });

  test('drops duplicate update_id replays', async () => {
    const receiver = telegramTrigger({ secretToken: SECRET });
    const events: TelegramMessage[] = [];
    receiver.message().start((m) => events.push(m));

    const update = { update_id: 7, message: privateMessage() };
    await receiver.handle(makeRequest(update));
    const second = await receiver.handle(makeRequest(update));

    expect(second.status).toBe(200);
    expect(await second.text()).toBe('duplicate');
    expect(events).toHaveLength(1);
  });

  test('command filter only matches configured commands', async () => {
    const receiver = telegramTrigger({ secretToken: SECRET });
    const events: TelegramMessage[] = [];
    receiver.message({ commands: ['start'] }).start((m) => events.push(m));

    await receiver.handle(
      makeRequest({
        update_id: 1,
        message: privateMessage({ text: '/start@mybot now' }),
      }),
    );
    await receiver.handle(
      makeRequest({
        update_id: 2,
        message: privateMessage({ text: 'just chatting' }),
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.text).toBe('/start@mybot now');
  });

  test('botUsername routes @-addressed commands to this bot only', async () => {
    const receiver = telegramTrigger({ secretToken: SECRET });
    const events: TelegramMessage[] = [];
    receiver
      .message({ commands: ['start'], botUsername: 'mybot' })
      .start((m) => events.push(m));

    await receiver.handle(
      makeRequest({
        update_id: 1,
        message: privateMessage({ text: '/start@otherbot' }),
      }),
    );
    await receiver.handle(
      makeRequest({
        update_id: 2,
        message: privateMessage({ text: '/start@MyBot' }),
      }),
    );
    await receiver.handle(
      makeRequest({
        update_id: 3,
        message: privateMessage({ text: '/start' }),
      }),
    );

    expect(events.map((m) => m.text)).toEqual(['/start@MyBot', '/start']);
  });
});

describe('splitMessage', () => {
  test('returns a single chunk under the limit', () => {
    expect(splitMessage('hello')).toEqual(['hello']);
  });

  test('throws when max is below 1', () => {
    expect(() => splitMessage('x', 0)).toThrow('max >= 1');
  });

  test('splits long text into 4096-unit chunks', () => {
    const chunks = splitMessage('x'.repeat(9000));
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(4096);
    expect(chunks.join('')).toHaveLength(9000);
  });

  test('prefers splitting on a newline within the window', () => {
    const text = `${'a'.repeat(4000)}\n${'b'.repeat(4000)}`;
    const chunks = splitMessage(text);
    expect(chunks[0]).toBe('a'.repeat(4000));
    expect(chunks[1]).toBe('b'.repeat(4000));
  });
});

describe('TelegramClient', () => {
  afterEach(() => {
    spyOn(globalThis, 'fetch').mockRestore();
  });

  test('sendMessage issues one API call per chunk', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      (async () =>
        new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
          headers: { 'content-type': 'application/json' },
        })) as never,
    );

    const client = new TelegramClient('token');
    const sent = await client.sendMessage(42, 'y'.repeat(9000));

    expect(sent).toHaveLength(3);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  test('refuses to auto-split formatted text over the limit', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      (async () =>
        new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
          headers: { 'content-type': 'application/json' },
        })) as never,
    );

    const client = new TelegramClient('token');
    await expect(
      client.sendMessage(42, 'z'.repeat(5000), { parseMode: 'HTML' }),
    ).rejects.toThrow('parse_mode');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('throws when the API responds with ok: false', async () => {
    spyOn(globalThis, 'fetch').mockImplementation(
      (async () =>
        new Response(
          JSON.stringify({ ok: false, description: 'chat not found' }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        )) as never,
    );

    const client = new TelegramClient('token');
    await expect(client.sendMessage(42, 'hi')).rejects.toThrow(
      'chat not found',
    );
  });
});
