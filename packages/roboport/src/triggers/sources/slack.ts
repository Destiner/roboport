import { telemetry } from '@/core/telemetry';

import { dispatch, makeBus, subscribe } from '../bus';
import type { Trigger } from '../core';
import { hmacSha256Hex, SeenCache, timingSafeEqual } from '../shared';

// Envelope fields Slack wraps around every Events API delivery. Merged onto the
// inner event so handlers can route by workspace / dedup id without the outer
// payload.
interface SlackEventContext {
  team_id: string;
  api_app_id: string;
  event_id?: string;
  event_time?: number;
}

interface SlackAppMention {
  type: 'app_mention';
  user: string;
  text: string;
  ts: string;
  channel: string;
  event_ts: string;
  thread_ts?: string;
}

interface SlackMessage {
  type: 'message';
  channel: string;
  user?: string;
  text?: string;
  ts: string;
  event_ts: string;
  channel_type?: string;
  thread_ts?: string;
  subtype?: string;
  bot_id?: string;
}

type SlackReactionAction = 'reaction_added' | 'reaction_removed';

interface SlackReaction {
  type: SlackReactionAction;
  user: string;
  reaction: string;
  item: { type: string; channel: string; ts: string };
  item_user?: string;
  event_ts: string;
}

type SlackAppMentionEvent = SlackAppMention & SlackEventContext;
type SlackMessageEvent = SlackMessage & SlackEventContext;
type SlackReactionEvent = SlackReaction & SlackEventContext;

interface SlackEnvelope {
  token?: string;
  team_id: string;
  api_app_id: string;
  type: string;
  event_id?: string;
  event_time?: number;
  challenge?: string;
  event?: { type: string; [key: string]: unknown };
}

interface SlackReceiverOptions {
  signingSecret: string;
  eventCacheSize?: number;
}

const DEFAULT_EVENT_CACHE_SIZE = 1024;
// Slack signs requests within a 5-minute window; older ones are replays.
const REPLAY_WINDOW_SECONDS = 60 * 5;
const SLACK_API_URL = 'https://slack.com/api';

class SlackReceiver {
  private appMentionBus = makeBus<SlackAppMentionEvent>();
  private messageBus = makeBus<SlackMessageEvent>();
  private reactionBus = makeBus<SlackReactionEvent>();
  private readonly signingSecret: string;
  private readonly events: SeenCache<string>;

  constructor(options: SlackReceiverOptions) {
    if (!options.signingSecret) {
      throw new Error('SlackReceiver requires a non-empty signingSecret');
    }
    this.signingSecret = options.signingSecret;
    this.events = new SeenCache(
      options.eventCacheSize ?? DEFAULT_EVENT_CACHE_SIZE,
    );
  }

  appMention(): Trigger<SlackAppMentionEvent> {
    const bus = this.appMentionBus;
    return {
      name: 'slack:app_mention',
      start: (emit) => subscribe(bus, emit),
    };
  }

  message(opts?: {
    // Drop messages the bot itself (or other bots) posted, so an agent can't
    // loop on its own replies. On by default.
    ignoreBots?: boolean;
    channelTypes?: string[];
  }): Trigger<SlackMessageEvent> {
    const bus = this.messageBus;
    const ignoreBots = opts?.ignoreBots ?? true;
    const channelTypes = opts?.channelTypes;
    function filter(e: SlackMessageEvent): boolean {
      if (ignoreBots && (e.bot_id || e.subtype === 'bot_message')) return false;
      if (
        channelTypes &&
        (e.channel_type === undefined || !channelTypes.includes(e.channel_type))
      ) {
        return false;
      }
      return true;
    }
    return {
      name: 'slack:message',
      start: (emit) => subscribe(bus, emit, filter),
    };
  }

  reaction(opts?: {
    actions?: SlackReactionAction[];
  }): Trigger<SlackReactionEvent> {
    const bus = this.reactionBus;
    const actions = opts?.actions;
    return {
      name: 'slack:reaction',
      start: (emit) =>
        subscribe(
          bus,
          emit,
          actions ? (e): boolean => actions.includes(e.type) : undefined,
        ),
    };
  }

  // Verify Slack's v0 signature over `v0:{timestamp}:{rawBody}`, rejecting
  // requests outside the replay window.
  private async verify(req: Request, body: string): Promise<boolean> {
    const ts = req.headers.get('x-slack-request-timestamp');
    const sig = req.headers.get('x-slack-signature');
    if (!ts || !sig) return false;
    const age = Math.abs(Date.now() / 1000 - Number(ts));
    if (!Number.isFinite(age) || age > REPLAY_WINDOW_SECONDS) return false;
    const expected = `v0=${await hmacSha256Hex(this.signingSecret, `v0:${ts}:${body}`)}`;
    return timingSafeEqual(sig, expected);
  }

  handle = async (req: Request): Promise<Response> => {
    const body = await req.text();
    if (!(await this.verify(req, body))) {
      return new Response('invalid signature', { status: 401 });
    }

    let payload: SlackEnvelope;
    try {
      payload = JSON.parse(body) as SlackEnvelope;
    } catch {
      return new Response('invalid json', { status: 400 });
    }

    // Slack confirms an Events API endpoint by echoing a one-time challenge.
    if (payload.type === 'url_verification') {
      return new Response(payload.challenge ?? '', {
        headers: { 'content-type': 'text/plain' },
      });
    }

    const eventId = payload.event_id;
    if (eventId && this.events.has(eventId)) {
      return new Response('duplicate', { status: 200 });
    }

    const event = payload.event;
    if (event) {
      const eventContext: SlackEventContext = {
        team_id: payload.team_id,
        api_app_id: payload.api_app_id,
        event_id: payload.event_id,
        event_time: payload.event_time,
      };
      // Ingress span linked to any upstream trace. Dispatch is fire-and-forget,
      // so this marks receipt, not the agent turn it triggers, and stays a root
      // of roboport's own trace — linked to, not parented by, the caller.
      const upstream = telemetry.linkFromCarrier(
        Object.fromEntries(req.headers),
      );
      telemetry.ingress(
        'trigger.receive',
        {
          attributes: {
            'trigger.source': 'slack',
            ...(payload.event_id
              ? { 'trigger.event.id': payload.event_id }
              : {}),
          },
          ...(upstream ? { links: [upstream] } : {}),
        },
        () => {
          switch (event.type) {
            case 'app_mention':
              dispatch(this.appMentionBus, {
                ...(event as unknown as SlackAppMention),
                ...eventContext,
              });
              break;
            case 'message':
              dispatch(this.messageBus, {
                ...(event as unknown as SlackMessage),
                ...eventContext,
              });
              break;
            case 'reaction_added':
            case 'reaction_removed':
              dispatch(this.reactionBus, {
                ...(event as unknown as SlackReaction),
                ...eventContext,
              });
              break;
            default:
              break;
          }
        },
      );
    }

    if (eventId) this.events.add(eventId);
    return new Response('ok', { status: 200 });
  };
}

interface SlackPostMessageResult {
  ok: boolean;
  channel: string;
  ts: string;
}

// Carries the stable Slack `error` code so callers (and a future channel) can
// branch on `channel_not_found` vs. retryable throttling without parsing the
// message. On HTTP 429 `code` is `rate_limited` and `retryAfter` is the
// `Retry-After` delay in seconds.
class SlackApiError extends Error {
  readonly method: string;
  readonly code: string;
  readonly status: number;
  readonly retryAfter?: number;

  constructor(opts: {
    method: string;
    code: string;
    status: number;
    retryAfter?: number;
  }) {
    super(`Slack ${opts.method} failed (${opts.status}): ${opts.code}`);
    this.name = 'SlackApiError';
    this.method = opts.method;
    this.code = opts.code;
    this.status = opts.status;
    this.retryAfter = opts.retryAfter;
  }
}

// Outbound Web API client. Colocated with the receiver so a Slack app (or a
// future channel) can reply, stream-edit, react, and link back without pulling
// in the MCP preset.
class SlackClient {
  private readonly token: string;
  private readonly baseUrl: string;

  constructor(token: string, opts?: { baseUrl?: string }) {
    if (!token) throw new Error('SlackClient requires a bot token');
    this.token = token;
    this.baseUrl = (opts?.baseUrl ?? SLACK_API_URL).replace(/\/+$/, '');
  }

  private call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    return telemetry.span(
      'trigger.send',
      {
        kind: telemetry.SpanKind.CLIENT,
        attributes: { 'trigger.source': 'slack', 'rpc.method': method },
      },
      async (): Promise<T> => {
        const body = new URLSearchParams();
        for (const [key, value] of Object.entries(params)) {
          if (value === undefined || value === null) continue;
          body.set(
            key,
            typeof value === 'string' ? value : JSON.stringify(value),
          );
        }
        const res = await fetch(`${this.baseUrl}/${method}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.token}`,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body,
        });
        // Throttling: Slack sends HTTP 429 with a `Retry-After` (seconds) header.
        if (res.status === 429) {
          const retryAfter = Number(res.headers.get('retry-after'));
          throw new SlackApiError({
            method,
            code: 'rate_limited',
            status: 429,
            retryAfter: Number.isFinite(retryAfter) ? retryAfter : undefined,
          });
        }
        // Otherwise Slack returns HTTP 200 with `{ ok: false, error }` for
        // API-level failures.
        const data = (await res.json()) as { ok: boolean; error?: string } & T;
        if (!data.ok) {
          throw new SlackApiError({
            method,
            code: data.error ?? 'unknown_error',
            status: res.status,
          });
        }
        return data;
      },
    );
  }

  postMessage(
    channel: string,
    text: string,
    opts?: { threadTs?: string; blocks?: unknown[] },
  ): Promise<SlackPostMessageResult> {
    return this.call<SlackPostMessageResult>('chat.postMessage', {
      channel,
      text,
      thread_ts: opts?.threadTs || undefined,
      blocks: opts?.blocks,
    });
  }

  updateMessage(
    channel: string,
    ts: string,
    text: string,
  ): Promise<SlackPostMessageResult> {
    return this.call<SlackPostMessageResult>('chat.update', {
      channel,
      ts,
      text,
    });
  }

  addReaction(
    channel: string,
    ts: string,
    name: string,
  ): Promise<{ ok: boolean }> {
    return this.call('reactions.add', { channel, timestamp: ts, name });
  }

  getPermalink(channel: string, ts: string): Promise<{ permalink: string }> {
    return this.call('chat.getPermalink', { channel, message_ts: ts });
  }
}

function slack(options: SlackReceiverOptions): SlackReceiver {
  return new SlackReceiver(options);
}

export {
  slack,
  SlackApiError,
  SlackClient,
  SlackReceiver,
  type SlackAppMentionEvent,
  type SlackEventContext,
  type SlackMessageEvent,
  type SlackPostMessageResult,
  type SlackReactionAction,
  type SlackReactionEvent,
  type SlackReceiverOptions,
};
