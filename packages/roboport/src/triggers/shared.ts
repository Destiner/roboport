// Constant-time string compare — avoids leaking match length via timing.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// Lowercase-hex HMAC-SHA256 of `body` keyed by `secret`.
async function hmacSha256Hex(secret: string, body: string): Promise<string> {
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
  return Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// FIFO set of recently seen delivery ids. Webhook senders retry any non-2xx
// delivery, so receivers drop replays they have already dispatched.
class SeenCache<T> {
  private seen = new Set<T>();
  private order: T[] = [];
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  has(id: T): boolean {
    return this.seen.has(id);
  }

  add(id: T): void {
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.order.push(id);
    while (this.order.length > this.maxSize) {
      const dropped = this.order.shift();
      if (dropped !== undefined) this.seen.delete(dropped);
    }
  }
}

export { hmacSha256Hex, SeenCache, timingSafeEqual };
