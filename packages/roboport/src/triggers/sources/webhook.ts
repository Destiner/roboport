import { dispatch, makeBus, subscribe } from '../bus';
import type { Trigger } from '../core';
import { hmacSha256Hex, SeenCache, timingSafeEqual } from '../shared';

interface WebhookEvent {
  body: unknown;
  headers: Record<string, string>;
}

interface WebhookReceiverOptions {
  // When set, verify an HMAC-SHA256 signature over the raw body.
  secret?: string;
  // Header carrying the signature (default GitHub-style 'x-hub-signature-256').
  signatureHeader?: string;
  // Prefix on the signature value (default 'sha256=').
  signaturePrefix?: string;
  // When set, dedup retries on this header's value (e.g. 'x-github-delivery').
  idHeader?: string;
  deliveryCacheSize?: number;
}

const DEFAULT_DELIVERY_CACHE_SIZE = 1024;

class WebhookReceiver {
  private bus = makeBus<WebhookEvent>();
  private readonly secret?: string;
  private readonly signatureHeader: string;
  private readonly signaturePrefix: string;
  private readonly idHeader?: string;
  private readonly deliveries: SeenCache<string>;

  constructor(options?: WebhookReceiverOptions) {
    this.secret = options?.secret;
    this.signatureHeader = options?.signatureHeader ?? 'x-hub-signature-256';
    this.signaturePrefix = options?.signaturePrefix ?? 'sha256=';
    this.idHeader = options?.idHeader;
    this.deliveries = new SeenCache(
      options?.deliveryCacheSize ?? DEFAULT_DELIVERY_CACHE_SIZE,
    );
  }

  event(opts?: {
    filter?: (event: WebhookEvent) => boolean;
  }): Trigger<WebhookEvent> {
    const bus = this.bus;
    const filter = opts?.filter;
    return {
      name: 'webhook',
      start: (emit) => subscribe(bus, emit, filter),
    };
  }

  private async verify(
    body: string,
    signature: string | null,
  ): Promise<boolean> {
    if (!this.secret) return true;
    if (!signature || !signature.startsWith(this.signaturePrefix)) return false;
    const provided = signature.slice(this.signaturePrefix.length).toLowerCase();
    if (!/^[0-9a-f]+$/.test(provided)) return false;
    const computed = await hmacSha256Hex(this.secret, body);
    return timingSafeEqual(provided, computed);
  }

  handle = async (req: Request): Promise<Response> => {
    const body = await req.text();
    if (!(await this.verify(body, req.headers.get(this.signatureHeader)))) {
      return new Response('invalid signature', { status: 401 });
    }

    const id = this.idHeader ? req.headers.get(this.idHeader) : null;
    if (id && this.deliveries.has(id)) {
      return new Response('duplicate', { status: 200 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return new Response('invalid json', { status: 400 });
    }

    dispatch(this.bus, {
      body: payload,
      headers: Object.fromEntries(req.headers),
    });
    if (id) this.deliveries.add(id);
    return new Response('ok', { status: 200 });
  };
}

function webhook(options?: WebhookReceiverOptions): WebhookReceiver {
  return new WebhookReceiver(options);
}

export {
  webhook,
  WebhookReceiver,
  type WebhookEvent,
  type WebhookReceiverOptions,
};
