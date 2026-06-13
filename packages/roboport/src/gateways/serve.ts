import { Agent, Session, type Message, type TextPart, type Turn } from '@/core';

import type {
  Channel,
  Gateway,
  GatewayHandler,
  InboundMessage,
  Relay,
} from './core';
import { memoryStore, type ConversationStore } from './store';

// Every default is a seam: start from `serve(agent, gateway)` and override only
// what you need. Returning `null` from `prompt` skips the turn (e.g. to handle a
// command yourself); `context` selects what the model sees this turn (default:
// the full stored history); `systemExtension` is appended to `agent.system`.
interface ServeOptions<In extends InboundMessage, Ch extends Channel> {
  conversation?: (message: In) => string;
  authorize?: (message: In, channel: Ch) => boolean | Promise<boolean>;
  systemExtension?: (message: In) => string | Promise<string>;
  prompt?: (message: In) => string | TextPart[] | null;
  context?: (stored: Message[], message: In) => Message[] | Promise<Message[]>;
  relay?: Relay<Ch>;
  store?: ConversationStore;
  onError?: (error: Error, channel: Ch, message: In) => void | Promise<void>;
}

interface GatewayRuntime {
  stop(): Promise<void>;
  handle?(req: Request): Promise<Response>;
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
async function bufferReplies(turn: Turn, channel: Channel): Promise<void> {
  const blocks: string[] = [];
  let failure: Error | null = null;
  for await (const event of turn) {
    if (event.type === 'text') blocks.push(event.text);
    else if (event.type === 'error') failure = event.error;
  }
  const reply = blocks.join('\n\n').trim();
  if (failure && !reply) throw failure;
  await channel.send(reply || '(no response)');
}

async function defaultError(error: Error, channel: Channel): Promise<void> {
  await channel
    .send(`Sorry — something went wrong: ${error.message}`)
    .catch(() => {});
}

// Bind an agent to a gateway: one long-lived conversation per `conversationId`,
// serialized per conversation (Session.send throws on a concurrent turn), with
// the agent's reply relayed back. The single entry point — grow into the seams
// over time, or drop to `gateway.open()` for fully custom routing.
function serve<In extends InboundMessage, Ch extends Channel>(
  agent: Agent,
  gateway: Gateway<In, Ch>,
  options: ServeOptions<In, Ch> = {},
): GatewayRuntime {
  const store = options.store ?? memoryStore();
  const keyOf =
    options.conversation ?? ((message: In): string => message.conversationId);
  const relay: Relay<Ch> = options.relay ?? gateway.relay ?? bufferReplies;
  const queues = new Map<string, Promise<unknown>>();

  async function runTurn(message: In, channel: Ch, id: string): Promise<void> {
    let stopThinking: (() => void) | undefined;
    try {
      if (options.authorize && !(await options.authorize(message, channel))) {
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
      const systemExtension = options.systemExtension
        ? await options.systemExtension(message)
        : undefined;

      const session = agent.session({ messages: seed, systemExtension });
      // Persist the user turn before running, so a mid-turn crash still records it.
      await store.append(id, toUserMessage(promptValue));
      stopThinking = channel.thinking?.();
      try {
        const turn = session.send(promptValue);
        await relay(turn, channel, message);
        stopThinking?.();
        stopThinking = undefined;
        await store.append(id, ...newMessages(session, seed.length));
      } finally {
        await session.close();
      }
    } catch (error) {
      stopThinking?.();
      const err = error instanceof Error ? error : new Error(String(error));
      if (options.onError) await options.onError(err, channel, message);
      else await defaultError(err, channel);
    }
  }

  function handler(message: In, channel: Ch): void {
    const id = keyOf(message);
    // Enqueue synchronously so same-conversation messages keep arrival order.
    const prior = queues.get(id) ?? Promise.resolve();
    const next = prior
      .then(() => runTurn(message, channel, id))
      .catch((error: unknown) => {
        console.error(`[gateways] ${gateway.name} ${id}:`, error);
      });
    queues.set(id, next);
    void next.finally(() => {
      if (queues.get(id) === next) queues.delete(id);
    });
  }

  const opened = Promise.resolve(
    gateway.open(handler as GatewayHandler<In, Ch>),
  );
  opened.catch(() => {});

  const runtime: GatewayRuntime = {
    async stop(): Promise<void> {
      const unsub = await opened;
      await unsub();
    },
  };
  if (gateway.handle) {
    runtime.handle = (req: Request): Promise<Response> => gateway.handle!(req);
  }
  return runtime;
}

export { serve, type GatewayRuntime, type ServeOptions };
