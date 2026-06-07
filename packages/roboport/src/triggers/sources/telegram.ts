import { dispatch, makeBus, subscribe } from '../bus';
import type { Trigger } from '../core';

interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  reply_to_message?: TelegramMessage;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

type TelegramChatAction =
  | 'typing'
  | 'upload_photo'
  | 'record_video'
  | 'upload_video'
  | 'record_voice'
  | 'upload_voice'
  | 'upload_document'
  | 'choose_sticker'
  | 'find_location';

interface SendMessageOptions {
  parseMode?: 'MarkdownV2' | 'HTML';
  replyToMessageId?: number;
  disableNotification?: boolean;
  // Maps to link_preview_options.is_disabled when false.
  linkPreview?: boolean;
}

interface TelegramReceiverOptions {
  secretToken: string;
  updateCacheSize?: number;
}

const DEFAULT_UPDATE_CACHE_SIZE = 1024;
const TELEGRAM_API_BASE = 'https://api.telegram.org';
// Telegram caps message text at 4096 UTF-16 code units.
const MAX_MESSAGE_LENGTH = 4096;

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// FIFO set of seen update_ids. Telegram retries any non-2xx delivery, so the
// receiver must drop replays it has already dispatched.
class UpdateCache {
  private seen = new Set<number>();
  private order: number[] = [];
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  has(id: number): boolean {
    return this.seen.has(id);
  }

  add(id: number): void {
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.order.push(id);
    while (this.order.length > this.maxSize) {
      const dropped = this.order.shift();
      if (dropped !== undefined) this.seen.delete(dropped);
    }
  }
}

function matchesCommand(
  message: TelegramMessage,
  commands: string[],
  botUsername?: string,
): boolean {
  const text = message.text;
  if (!text || !text.startsWith('/')) return false;
  // "/cmd@botname args" -> name="cmd", target="botname"
  const token = text.slice(1).split(/\s/, 1)[0] ?? '';
  const [name, target] = token.split('@');
  // A command addressed to a specific bot (/cmd@bot) only matches when it
  // targets us. Without a configured username we can't tell, so stay lenient.
  if (target && botUsername) {
    const normalized = botUsername.replace(/^@/, '').toLowerCase();
    if (target.toLowerCase() !== normalized) return false;
  }
  return commands.some(
    (command) =>
      (command.startsWith('/') ? command.slice(1) : command) === name,
  );
}

class TelegramReceiver {
  private messageBus = makeBus<TelegramMessage>();
  private editedMessageBus = makeBus<TelegramMessage>();
  private readonly secretToken: string;
  private readonly updates: UpdateCache;

  constructor(options: TelegramReceiverOptions) {
    if (!options.secretToken) {
      throw new Error('TelegramReceiver requires a non-empty secretToken');
    }
    this.secretToken = options.secretToken;
    this.updates = new UpdateCache(
      options.updateCacheSize ?? DEFAULT_UPDATE_CACHE_SIZE,
    );
  }

  message(opts?: {
    commands?: string[];
    botUsername?: string;
  }): Trigger<TelegramMessage> {
    const bus = this.messageBus;
    const commands = opts?.commands;
    const botUsername = opts?.botUsername;
    return {
      name: 'telegram:message',
      start: (emit) =>
        subscribe(
          bus,
          emit,
          commands
            ? (m): boolean => matchesCommand(m, commands, botUsername)
            : undefined,
        ),
    };
  }

  editedMessage(): Trigger<TelegramMessage> {
    const bus = this.editedMessageBus;
    return {
      name: 'telegram:edited_message',
      start: (emit) => subscribe(bus, emit),
    };
  }

  // Verify the secret token, dedup on update_id, dispatch, and return 200 fast.
  // Handlers run fire-and-forget (Agent.start), so the HTTP response never waits
  // on agent work — Telegram would otherwise retry on the timeout.
  handle = async (req: Request): Promise<Response> => {
    const provided = req.headers.get('x-telegram-bot-api-secret-token');
    if (!provided || !timingSafeEqual(provided, this.secretToken)) {
      return new Response('invalid secret token', { status: 401 });
    }

    let update: TelegramUpdate;
    try {
      update = (await req.json()) as TelegramUpdate;
    } catch {
      return new Response('invalid json', { status: 400 });
    }

    if (typeof update.update_id !== 'number') {
      return new Response('missing update_id', { status: 400 });
    }
    if (this.updates.has(update.update_id)) {
      return new Response('duplicate', { status: 200 });
    }

    if (update.message) {
      dispatch(this.messageBus, update.message);
    } else if (update.edited_message) {
      dispatch(this.editedMessageBus, update.edited_message);
    }

    this.updates.add(update.update_id);
    return new Response('ok', { status: 200 });
  };
}

// Splits text on the 4096-unit limit, preferring the last newline within the
// window and never cutting a surrogate pair.
function splitMessage(text: string, max = MAX_MESSAGE_LENGTH): string[] {
  if (max < 1) throw new Error('splitMessage requires max >= 1');
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > max) {
    let cut = remaining.lastIndexOf('\n', max);
    if (cut <= 0) {
      cut = max;
      // Don't split a surrogate pair on a hard cut.
      const code = remaining.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    }
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n/, '');
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

// Outbound Bot API client. Colocated with the receiver because Telegram has no
// CLI equivalent to `gh`; an app needs this to reply.
class TelegramClient {
  private readonly token: string;
  private readonly baseUrl: string;

  constructor(token: string, opts?: { baseUrl?: string }) {
    if (!token) throw new Error('TelegramClient requires a bot token');
    this.token = token;
    this.baseUrl = (opts?.baseUrl ?? TELEGRAM_API_BASE).replace(/\/+$/, '');
  }

  private async call<T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    });
    const data = (await response.json()) as TelegramApiResponse<T>;
    if (!data.ok) {
      throw new Error(
        `Telegram ${method} failed (${response.status}): ${data.description ?? 'unknown error'}`,
      );
    }
    return data.result as T;
  }

  getMe(): Promise<TelegramUser> {
    return this.call<TelegramUser>('getMe', {});
  }

  sendChatAction(
    chatId: number | string,
    action: TelegramChatAction = 'typing',
  ): Promise<boolean> {
    return this.call<boolean>('sendChatAction', { chat_id: chatId, action });
  }

  // Sends text as one or more messages. Plain text is split at the 4096-unit
  // limit; when parseMode is set we refuse to auto-split, since chunking could
  // break Markdown/HTML entities — split formatted text yourself.
  async sendMessage(
    chatId: number | string,
    text: string,
    opts?: SendMessageOptions,
  ): Promise<TelegramMessage[]> {
    if (opts?.parseMode && text.length > MAX_MESSAGE_LENGTH) {
      throw new Error(
        `sendMessage: text exceeds ${MAX_MESSAGE_LENGTH} chars with parse_mode ${opts.parseMode}; auto-splitting could break entities. Split it yourself.`,
      );
    }
    const sent: TelegramMessage[] = [];
    for (const chunk of splitMessage(text)) {
      sent.push(
        await this.call<TelegramMessage>('sendMessage', {
          chat_id: chatId,
          text: chunk,
          ...(opts?.parseMode ? { parse_mode: opts.parseMode } : {}),
          ...(opts?.replyToMessageId
            ? { reply_parameters: { message_id: opts.replyToMessageId } }
            : {}),
          ...(opts?.disableNotification ? { disable_notification: true } : {}),
          ...(opts?.linkPreview === false
            ? { link_preview_options: { is_disabled: true } }
            : {}),
        }),
      );
    }
    return sent;
  }

  editMessageText(
    chatId: number | string,
    messageId: number,
    text: string,
    opts?: { parseMode?: 'MarkdownV2' | 'HTML' },
  ): Promise<TelegramMessage | boolean> {
    return this.call<TelegramMessage | boolean>('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...(opts?.parseMode ? { parse_mode: opts.parseMode } : {}),
    });
  }

  setWebhook(
    url: string,
    opts?: { secretToken?: string; allowedUpdates?: string[] },
  ): Promise<boolean> {
    return this.call<boolean>('setWebhook', {
      url,
      ...(opts?.secretToken ? { secret_token: opts.secretToken } : {}),
      ...(opts?.allowedUpdates ? { allowed_updates: opts.allowedUpdates } : {}),
    });
  }

  deleteWebhook(opts?: { dropPendingUpdates?: boolean }): Promise<boolean> {
    return this.call<boolean>('deleteWebhook', {
      ...(opts?.dropPendingUpdates ? { drop_pending_updates: true } : {}),
    });
  }
}

function telegram(options: TelegramReceiverOptions): TelegramReceiver {
  return new TelegramReceiver(options);
}

export {
  telegram,
  TelegramClient,
  TelegramReceiver,
  splitMessage,
  type SendMessageOptions,
  type TelegramChat,
  type TelegramChatAction,
  type TelegramMessage,
  type TelegramReceiverOptions,
  type TelegramUpdate,
  type TelegramUser,
};
