import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import {
  MAX_RICH_MESSAGE_LENGTH,
  splitMessage,
  TelegramClient,
  telegram,
  type RichMessage,
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
    const receiver = telegram({ secretToken: SECRET });
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
    const receiver = telegram({ secretToken: SECRET });
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
    const receiver = telegram({ secretToken: SECRET });
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
    const receiver = telegram({ secretToken: SECRET });
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
    const receiver = telegram({ secretToken: SECRET });
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

  test('sendMessage forwards message_thread_id so drafts finalize in-topic', async () => {
    let body: Record<string, unknown> = {};
    spyOn(globalThis, 'fetch').mockImplementation((async (
      _url: string,
      init: RequestInit,
    ) => {
      body = JSON.parse(init.body as string) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 1 } }),
        {
          headers: { 'content-type': 'application/json' },
        },
      );
    }) as never);

    const client = new TelegramClient('token');
    await client.sendMessage(42, 'done', { messageThreadId: 9 });

    expect(body).toMatchObject({
      chat_id: 42,
      text: 'done',
      message_thread_id: 9,
    });
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

  test('sendMessageDraft posts draft_id and text in one call', async () => {
    let body: Record<string, unknown> = {};
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (
      _url: string,
      init: RequestInit,
    ) => {
      body = JSON.parse(init.body as string) as Record<string, unknown>;
      return new Response(JSON.stringify({ ok: true, result: true }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as never);

    const client = new TelegramClient('token');
    const ok = await client.sendMessageDraft(42, 7, 'partial', {
      messageThreadId: 9,
    });

    expect(ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({
      chat_id: 42,
      draft_id: 7,
      text: 'partial',
      message_thread_id: 9,
    });
  });

  test('sendMessageDraft rejects a zero draftId without calling the API', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      (async () =>
        new Response(JSON.stringify({ ok: true, result: true }), {
          headers: { 'content-type': 'application/json' },
        })) as never,
    );

    const client = new TelegramClient('token');
    await expect(client.sendMessageDraft(42, 0, 'hi')).rejects.toThrow(
      'non-zero',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('sendMessageDraft refuses text over the single-bubble limit', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      (async () =>
        new Response(JSON.stringify({ ok: true, result: true }), {
          headers: { 'content-type': 'application/json' },
        })) as never,
    );

    const client = new TelegramClient('token');
    await expect(
      client.sendMessageDraft(42, 1, 'x'.repeat(5000)),
    ).rejects.toThrow('single bubble');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('sendRichMessage posts rich_message markdown without splitting', async () => {
    let body: Record<string, unknown> = {};
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (
      _url: string,
      init: RequestInit,
    ) => {
      body = JSON.parse(init.body as string) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 1 } }),
        { headers: { 'content-type': 'application/json' } },
      );
    }) as never);

    const client = new TelegramClient('token');
    await client.sendRichMessage(
      42,
      { markdown: '# Title\n\n- a\n- b' },
      { messageThreadId: 9 },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({
      chat_id: 42,
      rich_message: { markdown: '# Title\n\n- a\n- b' },
      message_thread_id: 9,
    });
  });

  test('sendRichMessage requires exactly one of markdown/html', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      (async () =>
        new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
          headers: { 'content-type': 'application/json' },
        })) as never,
    );

    const client = new TelegramClient('token');
    // The type forbids both invalid states; cast to exercise the runtime guard.
    await expect(client.sendRichMessage(42, {} as RichMessage)).rejects.toThrow(
      'exactly one',
    );
    await expect(
      client.sendRichMessage(42, {
        markdown: 'a',
        html: '<b>a</b>',
      } as unknown as RichMessage),
    ).rejects.toThrow('exactly one');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('sendRichMessage refuses content over the rich limit', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      (async () =>
        new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
          headers: { 'content-type': 'application/json' },
        })) as never,
    );

    const client = new TelegramClient('token');
    await expect(
      client.sendRichMessage(42, {
        markdown: 'x'.repeat(MAX_RICH_MESSAGE_LENGTH + 1),
      }),
    ).rejects.toThrow("can't be split");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('sendRichMessageDraft posts rich_message and draft_id', async () => {
    let body: Record<string, unknown> = {};
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (
      _url: string,
      init: RequestInit,
    ) => {
      body = JSON.parse(init.body as string) as Record<string, unknown>;
      return new Response(JSON.stringify({ ok: true, result: true }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as never);

    const client = new TelegramClient('token');
    const ok = await client.sendRichMessageDraft(42, 7, { markdown: '**hi**' });

    expect(ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({
      chat_id: 42,
      draft_id: 7,
      rich_message: { markdown: '**hi**' },
    });
  });

  test('sendRichMessageDraft accepts empty markdown to clear the draft', async () => {
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

    const client = new TelegramClient('token');
    await client.sendRichMessageDraft(42, 7, { markdown: '' });

    expect(body).toMatchObject({
      chat_id: 42,
      draft_id: 7,
      rich_message: { markdown: '' },
    });
  });

  test('sendRichMessageDraft rejects a zero draftId without calling the API', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      (async () =>
        new Response(JSON.stringify({ ok: true, result: true }), {
          headers: { 'content-type': 'application/json' },
        })) as never,
    );

    const client = new TelegramClient('token');
    await expect(
      client.sendRichMessageDraft(42, 0, { markdown: 'hi' }),
    ).rejects.toThrow('non-zero');
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
