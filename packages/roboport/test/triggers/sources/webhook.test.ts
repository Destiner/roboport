import { describe, expect, test } from 'bun:test';

import { webhook, type WebhookEvent } from '@/triggers/sources/webhook';

const SECRET = 'topsecret';

async function sign(secret: string, body: string): Promise<string> {
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
    new TextEncoder().encode(body),
  );
  const hex = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `sha256=${hex}`;
}

function makeRequest(
  body: string,
  headers: Record<string, string> = {},
): Request {
  return new Request('https://example.com/webhooks/custom', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

describe('WebhookReceiver.handle', () => {
  test('dispatches the parsed body and headers without a secret', async () => {
    const receiver = webhook();
    const events: WebhookEvent[] = [];
    receiver.event().start((e) => events.push(e));

    const res = await receiver.handle(
      makeRequest(JSON.stringify({ kind: 'deploy', id: 7 }), {
        'x-source': 'ci',
      }),
    );

    expect(res.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]?.body).toEqual({ kind: 'deploy', id: 7 });
    expect(events[0]?.headers['x-source']).toBe('ci');
  });

  test('verifies a valid signature and rejects a bad one', async () => {
    const receiver = webhook({ secret: SECRET });
    const events: WebhookEvent[] = [];
    receiver.event().start((e) => events.push(e));
    const body = JSON.stringify({ ok: true });

    const valid = await receiver.handle(
      makeRequest(body, { 'x-hub-signature-256': await sign(SECRET, body) }),
    );
    expect(valid.status).toBe(200);

    const bad = await receiver.handle(
      makeRequest(body, { 'x-hub-signature-256': 'sha256=deadbeef' }),
    );
    expect(bad.status).toBe(401);

    const missing = await receiver.handle(makeRequest(body));
    expect(missing.status).toBe(401);

    expect(events).toHaveLength(1);
  });

  test('supports a custom signature header and prefix', async () => {
    const receiver = webhook({
      secret: SECRET,
      signatureHeader: 'x-signature',
      signaturePrefix: 'v1=',
    });
    const events: WebhookEvent[] = [];
    receiver.event().start((e) => events.push(e));
    const body = JSON.stringify({ ok: true });
    const sig = (await sign(SECRET, body)).replace('sha256=', 'v1=');

    const res = await receiver.handle(
      makeRequest(body, { 'x-signature': sig }),
    );
    expect(res.status).toBe(200);
    expect(events).toHaveLength(1);
  });

  test('applies the subscription filter with a typed body', async () => {
    const receiver = webhook();
    const events: WebhookEvent<{ kind: string }>[] = [];
    receiver
      .event<{ kind: string }>({ filter: (e) => e.body.kind === 'deploy' })
      .start((e) => events.push(e));

    await receiver.handle(makeRequest(JSON.stringify({ kind: 'ping' })));
    await receiver.handle(makeRequest(JSON.stringify({ kind: 'deploy' })));

    expect(events).toHaveLength(1);
    expect(events[0]?.body.kind).toBe('deploy');
  });

  test('throws when secret is provided but empty', () => {
    expect(() => webhook({ secret: undefined })).toThrow('was provided');
    expect(() => webhook({ secret: '' })).toThrow('was provided');
    // No `secret` key at all is a valid unsigned receiver.
    expect(() => webhook({ idHeader: 'x-delivery' })).not.toThrow();
    expect(() => webhook()).not.toThrow();
  });

  test('dedups retries on the configured id header', async () => {
    const receiver = webhook({ idHeader: 'x-delivery' });
    const events: WebhookEvent[] = [];
    receiver.event().start((e) => events.push(e));
    const body = JSON.stringify({ ok: true });

    const first = await receiver.handle(
      makeRequest(body, { 'x-delivery': 'abc' }),
    );
    const replay = await receiver.handle(
      makeRequest(body, { 'x-delivery': 'abc' }),
    );

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(events).toHaveLength(1);
  });

  test('returns 400 on invalid json', async () => {
    const receiver = webhook();
    const events: WebhookEvent[] = [];
    receiver.event().start((e) => events.push(e));

    const res = await receiver.handle(makeRequest('not json'));

    expect(res.status).toBe(400);
    expect(events).toHaveLength(0);
  });
});
