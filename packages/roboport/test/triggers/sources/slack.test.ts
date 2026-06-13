import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  spyOn,
  test,
} from 'bun:test';

import {
  slack,
  SlackApiError,
  SlackClient,
  type SlackAppMentionEvent,
  type SlackMessageEvent,
  type SlackReactionEvent,
} from '@/triggers/sources/slack';

const SIGNING_SECRET = 'shhh';
const NOW = '2026-06-13T12:00:00Z';

function nowSeconds(): string {
  return String(Math.floor(new Date(NOW).getTime() / 1000));
}

async function v0Sign(
  secret: string,
  ts: string,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`v0:${ts}:${body}`),
  );
  const hex = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `v0=${hex}`;
}

async function signedRequest(
  envelope: unknown,
  opts?: { ts?: string; sig?: string },
): Promise<Request> {
  const body = JSON.stringify(envelope);
  const ts = opts?.ts ?? nowSeconds();
  const sig = opts?.sig ?? (await v0Sign(SIGNING_SECRET, ts, body));
  return new Request('https://example.com/webhooks/slack', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-slack-request-timestamp': ts,
      'x-slack-signature': sig,
    },
    body,
  });
}

function envelope(
  event: Record<string, unknown>,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    token: 'verif',
    team_id: 'T123',
    api_app_id: 'A123',
    type: 'event_callback',
    event_id: 'Ev1',
    event_time: 1,
    event,
    ...extra,
  };
}

beforeEach((): void => {
  setSystemTime(new Date(NOW));
});

afterEach((): void => {
  setSystemTime();
});

describe('SlackReceiver.handle', () => {
  test('echoes the url_verification challenge', async () => {
    const receiver = slack({ signingSecret: SIGNING_SECRET });
    const res = await receiver.handle(
      await signedRequest({ type: 'url_verification', challenge: 'abc123' }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('abc123');
  });

  test('dispatches app_mention with merged envelope context', async () => {
    const receiver = slack({ signingSecret: SIGNING_SECRET });
    const events: SlackAppMentionEvent[] = [];
    receiver.appMention().start((e) => events.push(e));

    const res = await receiver.handle(
      await signedRequest(
        envelope({
          type: 'app_mention',
          user: 'U1',
          text: '<@U0> hi',
          ts: '1.1',
          channel: 'C1',
          event_ts: '1.1',
        }),
      ),
    );

    expect(res.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]?.text).toBe('<@U0> hi');
    expect(events[0]?.team_id).toBe('T123');
    expect(events[0]?.event_id).toBe('Ev1');
  });

  test('message ignores bot posts by default but keeps user posts', async () => {
    const receiver = slack({ signingSecret: SIGNING_SECRET });
    const events: SlackMessageEvent[] = [];
    receiver.message().start((e) => events.push(e));

    await receiver.handle(
      await signedRequest(
        envelope(
          {
            type: 'message',
            channel: 'C1',
            bot_id: 'B1',
            text: 'from bot',
            ts: '1',
            event_ts: '1',
          },
          { event_id: 'Ev_bot' },
        ),
      ),
    );
    await receiver.handle(
      await signedRequest(
        envelope(
          {
            type: 'message',
            channel: 'C1',
            user: 'U1',
            text: 'from user',
            ts: '2',
            event_ts: '2',
          },
          { event_id: 'Ev_user' },
        ),
      ),
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.text).toBe('from user');
  });

  test('reaction filters by action', async () => {
    const receiver = slack({ signingSecret: SIGNING_SECRET });
    const events: SlackReactionEvent[] = [];
    receiver
      .reaction({ actions: ['reaction_added'] })
      .start((e) => events.push(e));

    await receiver.handle(
      await signedRequest(
        envelope(
          {
            type: 'reaction_removed',
            user: 'U1',
            reaction: 'x',
            item: { type: 'message', channel: 'C1', ts: '1' },
            event_ts: '1',
          },
          { event_id: 'Ev_rm' },
        ),
      ),
    );
    await receiver.handle(
      await signedRequest(
        envelope(
          {
            type: 'reaction_added',
            user: 'U1',
            reaction: 'tada',
            item: { type: 'message', channel: 'C1', ts: '2' },
            event_ts: '2',
          },
          { event_id: 'Ev_add' },
        ),
      ),
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.reaction).toBe('tada');
  });

  test('rejects a bad signature and a stale timestamp', async () => {
    const receiver = slack({ signingSecret: SIGNING_SECRET });
    const events: SlackAppMentionEvent[] = [];
    receiver.appMention().start((e) => events.push(e));
    const event = envelope({
      type: 'app_mention',
      user: 'U1',
      text: 'hi',
      ts: '1',
      channel: 'C1',
      event_ts: '1',
    });

    const bad = await receiver.handle(
      await signedRequest(event, { sig: 'v0=deadbeef' }),
    );
    expect(bad.status).toBe(401);

    const staleTs = String(Math.floor(new Date(NOW).getTime() / 1000) - 600);
    const stale = await receiver.handle(
      await signedRequest(event, { ts: staleTs }),
    );
    expect(stale.status).toBe(401);

    expect(events).toHaveLength(0);
  });

  test('dedups retries on event_id', async () => {
    const receiver = slack({ signingSecret: SIGNING_SECRET });
    const events: SlackAppMentionEvent[] = [];
    receiver.appMention().start((e) => events.push(e));
    const event = envelope({
      type: 'app_mention',
      user: 'U1',
      text: 'hi',
      ts: '1',
      channel: 'C1',
      event_ts: '1',
    });

    const first = await receiver.handle(await signedRequest(event));
    const replay = await receiver.handle(await signedRequest(event));

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(events).toHaveLength(1);
  });
});

describe('SlackClient', () => {
  afterEach(() => {
    spyOn(globalThis, 'fetch').mockRestore?.();
  });

  test('postMessage posts text to chat.postMessage', async () => {
    let captured: { url: string; body: string } | undefined;
    spyOn(globalThis, 'fetch').mockImplementation((async (
      url: string,
      init: RequestInit,
    ) => {
      captured = { url: String(url), body: String(init.body) };
      return new Response(
        JSON.stringify({ ok: true, channel: 'C1', ts: '9.9' }),
      );
    }) as never);

    const client = new SlackClient('xoxb-token');
    const result = await client.postMessage('C1', 'hello', { threadTs: '1.1' });

    expect(result.ts).toBe('9.9');
    expect(captured?.url).toBe('https://slack.com/api/chat.postMessage');
    const params = new URLSearchParams(captured?.body);
    expect(params.get('channel')).toBe('C1');
    expect(params.get('text')).toBe('hello');
    expect(params.get('thread_ts')).toBe('1.1');
  });

  test('throws a SlackApiError carrying the error code on ok: false', async () => {
    spyOn(globalThis, 'fetch').mockImplementation(
      (async () =>
        new Response(
          JSON.stringify({ ok: false, error: 'channel_not_found' }),
        )) as never,
    );

    const client = new SlackClient('xoxb-token');
    const err = await client.postMessage('C1', 'hi').catch((e) => e);
    expect(err).toBeInstanceOf(SlackApiError);
    expect(err.code).toBe('channel_not_found');
    expect(err.status).toBe(200);
  });

  test('surfaces Retry-After as a rate_limited SlackApiError on HTTP 429', async () => {
    spyOn(globalThis, 'fetch').mockImplementation(
      (async () =>
        new Response('', {
          status: 429,
          headers: { 'retry-after': '30' },
        })) as never,
    );

    const client = new SlackClient('xoxb-token');
    const err = await client.postMessage('C1', 'hi').catch((e) => e);
    expect(err).toBeInstanceOf(SlackApiError);
    expect(err.code).toBe('rate_limited');
    expect(err.status).toBe(429);
    expect(err.retryAfter).toBe(30);
  });
});
