import { Agent, Session, type Message, type TextPart, type Turn } from '@/core';
import { telemetry } from '@/core/telemetry';

import type { Channel, Conversation, InboundMessage, Relay } from './core';
import { memoryStore, type ConversationStore } from './store';

interface ServeOptions<In extends InboundMessage, Conv extends Conversation> {
  conversation?: (message: In) => string;
  authorize?: (message: In, conversation: Conv) => boolean | Promise<boolean>;
  systemExtension?: (message: In) => string | Promise<string>;
  prompt?: (message: In) => string | TextPart[] | null;
  context?: (stored: Message[], message: In) => Message[] | Promise<Message[]>;
  relay?: Relay<In, Conv>;
  store?: ConversationStore;
  onError?: (
    error: Error,
    conversation: Conv,
    message: In,
  ) => void | Promise<void>;
}

interface ChannelRuntime {
  stop(): Promise<void>;
  handle(req: Request): Promise<Response>;
}

function toUserMessage(prompt: string | TextPart[]): Message {
  return { role: 'user', content: prompt };
}

// The messages a turn added on top of the seed: everything after the prepended
// system message, the seed, and the user message we already persisted.
function newMessages(session: Session, seedLength: number): Message[] {
  const all = session.messages;
  const head = all[0]?.role === 'system' ? 1 : 0;
  return [...all.slice(head + seedLength + 1)];
}

// Default relay: buffer the turn's completed text blocks and send one reply.
async function bufferReplies(
  turn: Turn,
  conversation: Conversation,
  channelName?: string,
): Promise<void> {
  const blocks: string[] = [];
  let failure: Error | null = null;
  for await (const event of turn) {
    if (event.type === 'text') blocks.push(event.text);
    else if (event.type === 'error') failure = event.error;
  }
  const reply = blocks.join('\n\n').trim();
  if (failure && !reply) throw failure;
  await telemetry.span(
    'channel.send',
    {
      kind: telemetry.SpanKind.PRODUCER,
      attributes: {
        ...(channelName ? { 'channel.name': channelName } : {}),
        'channel.conversation.id': conversation.conversationId,
      },
    },
    () => conversation.send(reply || '(no response)'),
  );
}

// Keep the user-facing default generic — raw errors can carry provider response
// bodies or internal details. Callers wanting to surface specifics override onError.
async function defaultError(
  error: Error,
  conversation: Conversation,
): Promise<void> {
  console.error('[channels] turn failed:', error);
  await conversation.send('Sorry — something went wrong.').catch(() => {});
}

// Bind an agent to a channel: one long-lived conversation per `conversationId`,
// serialized per conversation (Session.send throws on a concurrent turn), with
// the agent's reply relayed back. The single entry point — grow into the seams
// over time, or drop to `channel.open()` for fully custom routing.
function serve<In extends InboundMessage, Conv extends Conversation>(
  agent: Agent,
  channel: Channel<In, Conv>,
  options: ServeOptions<In, Conv> = {},
): ChannelRuntime {
  const store = options.store ?? memoryStore();
  const keyOf =
    options.conversation ?? ((message: In): string => message.conversationId);
  const relay: Relay<In, Conv> =
    options.relay ??
    channel.relay ??
    ((turn, conversation): Promise<void> =>
      bufferReplies(turn, conversation, channel.name));
  const queues = new Map<string, Promise<unknown>>();

  function runTurn(message: In, conversation: Conv, id: string): Promise<void> {
    return telemetry.span(
      'channel.receive',
      {
        kind: telemetry.SpanKind.CONSUMER,
        attributes: {
          'channel.name': channel.name,
          'channel.conversation.id': id,
        },
      },
      () => runTurnInner(message, conversation, id),
    );
  }

  async function runTurnInner(
    message: In,
    conversation: Conv,
    id: string,
  ): Promise<void> {
    let stopThinking: (() => void) | undefined;
    try {
      if (
        options.authorize &&
        !(await options.authorize(message, conversation))
      ) {
        return;
      }
      const promptValue = options.prompt
        ? options.prompt(message)
        : message.text;
      if (promptValue === null) return;

      const stored = (await store.load(id)) ?? [];
      const seed = options.context
        ? await options.context(stored, message)
        : stored;
      // Snapshot before the eager append below, which may alias `seed`.
      const seedLength = seed.length;
      const systemExtension = options.systemExtension
        ? await options.systemExtension(message)
        : undefined;

      const session = agent.session({ messages: seed, systemExtension });
      // Persist the user turn before running, so a mid-turn crash still records it.
      await store.append(id, toUserMessage(promptValue));
      stopThinking = conversation.thinking?.();
      try {
        const turn = session.send(promptValue);
        await relay(turn, conversation, message);
        stopThinking?.();
        stopThinking = undefined;
        await store.append(id, ...newMessages(session, seedLength));
      } finally {
        await session.close();
      }
    } catch (error) {
      stopThinking?.();
      const err = error instanceof Error ? error : new Error(String(error));
      if (options.onError) await options.onError(err, conversation, message);
      else await defaultError(err, conversation);
    }
  }

  function handler(message: In, conversation: Conv): void {
    const id = keyOf(message);
    // Enqueue synchronously so same-conversation messages keep arrival order.
    const prior = queues.get(id) ?? Promise.resolve();
    const next = prior
      .then(() => runTurn(message, conversation, id))
      .catch((error: unknown) => {
        console.error(`[channels] ${channel.name} ${id}:`, error);
      });
    queues.set(id, next);
    void next.finally(() => {
      if (queues.get(id) === next) queues.delete(id);
    });
  }

  const opened = Promise.resolve(channel.open(handler));
  opened.catch((error: unknown) => {
    console.error(`[channels] ${channel.name} failed to open:`, error);
  });

  function notWebhook(): Promise<Response> {
    return Promise.resolve(
      new Response('channel is not in webhook mode', { status: 404 }),
    );
  }

  return {
    async stop(): Promise<void> {
      const unsub = await opened.catch(() => undefined);
      if (unsub) await unsub();
    },
    handle: channel.handle
      ? (req: Request): Promise<Response> => channel.handle!(req)
      : notWebhook,
  };
}

export { serve, type ChannelRuntime, type ServeOptions };
