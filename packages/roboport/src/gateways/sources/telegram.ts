import type { MaybePromise, Unsub } from '@/triggers/core';
import {
  matchesCommand,
  MAX_RICH_MESSAGE_LENGTH,
  TelegramClient,
  TelegramReceiver,
  type SendRichMessageOptions,
  type TelegramMessage,
} from '@/triggers/sources/telegram';

import type {
  Channel,
  Gateway,
  GatewayHandler,
  InboundMessage,
  Relay,
} from '../core';

interface TelegramChannel extends Channel {
  chatId: number;
  client: TelegramClient;
  send(text: string, opts?: SendRichMessageOptions): Promise<void>;
  draft(text: string): Promise<void>;
}

type TelegramTransport =
  | { mode: 'polling' }
  | { mode: 'webhook'; secretToken: string };

interface TelegramGatewayOptions {
  token: string;
  // Defaults to long-polling (no public URL needed). Webhook mode exposes
  // `handle` to mount in your HTTP server.
  transport?: TelegramTransport;
  // Only forward these slash-commands (applies to both transports).
  commands?: string[];
  botUsername?: string;
}

interface TelegramGateway extends Gateway<InboundMessage, TelegramChannel> {
  client: TelegramClient;
}

const TYPING_INTERVAL_MS = 4000;
const POLL_TIMEOUT_SECONDS = 25;
const POLL_BACKOFF_MS = 1000;
const DRAFT_THROTTLE_MS = 500;
const DRAFT_MAX_LENGTH = MAX_RICH_MESSAGE_LENGTH;

// Key per forum topic when present, so each topic is an independent session;
// otherwise per chat. Drafts/replies are routed back to the same topic.
function conversationKey(message: TelegramMessage): string {
  return message.message_thread_id !== undefined
    ? `${message.chat.id}:${message.message_thread_id}`
    : String(message.chat.id);
}

function toInbound(message: TelegramMessage): InboundMessage {
  return {
    id: String(message.message_id),
    conversationId: conversationKey(message),
    text: message.text ?? message.caption ?? '',
    user: message.from
      ? {
          id: String(message.from.id),
          name: message.from.username ?? message.from.first_name,
        }
      : undefined,
    replyToId: message.reply_to_message
      ? String(message.reply_to_message.message_id)
      : undefined,
    raw: message,
  };
}

// Telegram's typing indicator expires after ~5s, so re-send it while the turn
// runs. Returns a stop().
function startTyping(client: TelegramClient, chatId: number): () => void {
  let stopped = false;
  function tick(): void {
    if (!stopped) void client.sendChatAction(chatId, 'typing').catch(() => {});
  }
  tick();
  const interval = setInterval(tick, TYPING_INTERVAL_MS);
  return (): void => {
    stopped = true;
    clearInterval(interval);
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function telegramGateway(options: TelegramGatewayOptions): TelegramGateway {
  const client = new TelegramClient(options.token);
  const transport: TelegramTransport = options.transport ?? { mode: 'polling' };

  function channelFor(message: TelegramMessage): TelegramChannel {
    const chatId = message.chat.id;
    const threadId = message.message_thread_id;
    return {
      conversationId: conversationKey(message),
      chatId,
      client,
      // Default replies/drafts to the originating topic; caller opts win.
      send: async (
        text: string,
        opts?: SendRichMessageOptions,
      ): Promise<void> => {
        await client.sendRichMessage(
          chatId,
          { markdown: text },
          { messageThreadId: threadId, ...opts },
        );
      },
      draft: async (text: string): Promise<void> => {
        await client.sendRichMessageDraft(
          chatId,
          message.message_id,
          { markdown: text },
          { messageThreadId: threadId },
        );
      },
      thinking: (): (() => void) => startTyping(client, chatId),
    };
  }

  function forwards(message: TelegramMessage): boolean {
    return (
      !options.commands ||
      matchesCommand(message, options.commands, options.botUsername)
    );
  }

  function deliver(
    handler: GatewayHandler<InboundMessage, TelegramChannel>,
    message: TelegramMessage,
  ): void {
    void Promise.resolve(
      handler(toInbound(message), channelFor(message)),
    ).catch((error: unknown) => {
      console.error('[gateways] telegram handler error:', error);
    });
  }

  if (transport.mode === 'webhook') {
    const receiver = new TelegramReceiver({
      secretToken: transport.secretToken,
    });
    return {
      name: 'telegram',
      client,
      handle: receiver.handle,
      open(
        handler: GatewayHandler<InboundMessage, TelegramChannel>,
      ): MaybePromise<Unsub> {
        const trigger = receiver.message(
          options.commands
            ? { commands: options.commands, botUsername: options.botUsername }
            : undefined,
        );
        return trigger.start((message) => deliver(handler, message));
      },
    };
  }

  return {
    name: 'telegram',
    client,
    open(
      handler: GatewayHandler<InboundMessage, TelegramChannel>,
    ): MaybePromise<Unsub> {
      const controller = new AbortController();
      void (async (): Promise<void> => {
        // Long-polling and webhooks are mutually exclusive on a bot token.
        await client.deleteWebhook().catch(() => {});
        let offset: number | undefined;
        while (!controller.signal.aborted) {
          try {
            const updates = await client.getUpdates({
              offset,
              timeout: POLL_TIMEOUT_SECONDS,
              allowedUpdates: ['message'],
              signal: controller.signal,
            });
            for (const update of updates) {
              offset = update.update_id + 1;
              const message = update.message;
              if (message && forwards(message)) deliver(handler, message);
            }
          } catch (error) {
            if (controller.signal.aborted) break;
            // Surface failures (e.g. a bad token) instead of silently retrying
            // forever, then back off before the next poll.
            console.error('[gateways] telegram polling error:', error);
            await sleep(POLL_BACKOFF_MS);
          }
        }
      })();
      return (): void => controller.abort();
    },
  };
}

// Streaming relay for Telegram: refresh an ephemeral rich draft bubble as
// tokens arrive (throttled), then commit the final reply with sendRichMessage.
function stream(
  options: { throttleMs?: number } = {},
): Relay<InboundMessage, TelegramChannel> {
  const throttleMs = options.throttleMs ?? DRAFT_THROTTLE_MS;
  return async (turn, channel): Promise<void> => {
    const blocks: string[] = [];
    let current = '';
    let failure: Error | null = null;
    let inFlight = false;
    let lastSentAt = 0;
    let lastSentText = '';

    function preview(): string {
      return [blocks.join('\n\n'), current]
        .filter((part) => part.length > 0)
        .join('\n\n');
    }
    function refresh(): void {
      const body = preview();
      if (!body || body === lastSentText || body.length > DRAFT_MAX_LENGTH) {
        return;
      }
      if (inFlight || Date.now() - lastSentAt < throttleMs) return;
      inFlight = true;
      lastSentAt = Date.now();
      lastSentText = body;
      void channel
        .draft(body)
        .catch(() => {})
        .finally(() => {
          inFlight = false;
        });
    }

    for await (const event of turn) {
      if (event.type === 'text-delta') {
        current += event.text;
        refresh();
      } else if (event.type === 'text') {
        blocks.push(event.text);
        current = '';
        refresh();
      } else if (event.type === 'error') {
        failure = event.error;
      }
    }
    const reply = blocks.join('\n\n').trim();
    if (failure && !reply) throw failure;
    await channel.send(reply || '(no response)');
  };
}

export {
  stream,
  telegramGateway,
  type TelegramChannel,
  type TelegramGateway,
  type TelegramGatewayOptions,
  type TelegramTransport,
};
