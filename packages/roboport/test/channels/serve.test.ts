import { describe, expect, spyOn, test } from 'bun:test';

import {
  memoryStore,
  serve,
  type Channel,
  type ChannelHandler,
  type Conversation,
  type InboundMessage,
} from '@/channels';
import { Agent, Model, type ModelStreamEvent, type SearchHit } from '@/core';

class StubModel extends Model {
  private behavior: { reply?: string; throwError?: string };

  constructor(behavior: { reply?: string; throwError?: string } = {}) {
    super();
    this.behavior = behavior;
  }

  async *streamMessage(): AsyncIterable<ModelStreamEvent> {
    if (this.behavior.throwError) throw new Error(this.behavior.throwError);
    const reply = this.behavior.reply ?? 'ok';
    yield { type: 'text-delta', text: reply };
    yield { type: 'text-end', text: reply };
    yield {
      type: 'message-end',
      id: '1',
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  async searchWeb(): Promise<SearchHit[]> {
    return [];
  }
}

function stubAgent(
  behavior: { reply?: string; throwError?: string } = {},
): Agent {
  return new Agent({
    model: new StubModel(behavior),
    system: 'sys',
    tools: [],
    skills: [],
  });
}

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return { id: '1', conversationId: 'c1', text: 'hello', ...overrides };
}

function makeFakeChannel(): {
  channel: Channel<InboundMessage, Conversation>;
  deliver: (message: InboundMessage) => void;
  sent: string[];
} {
  let handler: ChannelHandler<InboundMessage, Conversation> | null = null;
  const sent: string[] = [];
  const channel: Channel<InboundMessage, Conversation> = {
    name: 'fake',
    open(h: ChannelHandler<InboundMessage, Conversation>): () => void {
      handler = h;
      return (): void => {};
    },
  };
  function deliver(message: InboundMessage): void {
    const conversation: Conversation = {
      conversationId: message.conversationId,
      send: async (text: string): Promise<void> => {
        sent.push(text);
      },
    };
    handler?.(message, conversation);
  }
  return { channel, deliver, sent };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await sleep(5);
  }
}

describe('serve', () => {
  test('runs a turn, relays the reply, persists user + assistant', async () => {
    const store = memoryStore();
    const { channel, deliver, sent } = makeFakeChannel();
    serve(stubAgent({ reply: 'hi there' }), channel, { store });

    deliver(inbound({ text: 'hello' }));
    await waitFor(() => sent.length === 1);

    expect(sent[0]).toBe('hi there');
    expect(await store.load('c1')).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
    ]);
  });

  test('serializes turns per conversation in arrival order', async () => {
    const store = memoryStore();
    const { channel, deliver, sent } = makeFakeChannel();
    serve(stubAgent({ reply: 'r' }), channel, { store });

    deliver(inbound({ text: 'first' }));
    deliver(inbound({ text: 'second' }));
    await waitFor(() => sent.length === 2);

    const stored = await store.load('c1');
    const userTexts = stored
      ?.filter((m) => m.role === 'user')
      .map((m) => (typeof m.content === 'string' ? m.content : ''));
    expect(userTexts).toEqual(['first', 'second']);
  });

  test('authorize=false drops the message without replying or persisting', async () => {
    const store = memoryStore();
    const { channel, deliver, sent } = makeFakeChannel();
    serve(stubAgent(), channel, { store, authorize: (): boolean => false });

    deliver(inbound());
    await sleep(50);

    expect(sent).toHaveLength(0);
    expect(await store.load('c1')).toBeNull();
  });

  test('prompt returning null skips the turn', async () => {
    const store = memoryStore();
    const { channel, deliver, sent } = makeFakeChannel();
    serve(stubAgent(), channel, { store, prompt: (): null => null });

    deliver(inbound());
    await sleep(50);

    expect(sent).toHaveLength(0);
    expect(await store.load('c1')).toBeNull();
  });

  test('persists assistant turns across turns (memoryStore is not aliased)', async () => {
    const store = memoryStore();
    const { channel, deliver, sent } = makeFakeChannel();
    serve(stubAgent({ reply: 'r' }), channel, { store });

    deliver(inbound({ text: 'first' }));
    await waitFor(() => sent.length === 1);
    deliver(inbound({ text: 'second' }));
    await waitFor(() => sent.length === 2);

    const stored = await store.load('c1');
    expect(stored?.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
  });

  test('default error reply is generic and does not leak the raw message', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const { channel, deliver, sent } = makeFakeChannel();
    serve(stubAgent({ throwError: 'secret upstream detail' }), channel, {});

    deliver(inbound());
    await waitFor(() => sent.length === 1);

    expect(sent[0]).toBe('Sorry — something went wrong.');
    expect(sent[0]).not.toContain('secret upstream detail');
    errorSpy.mockRestore();
  });

  test('onError receives a thrown turn error', async () => {
    const store = memoryStore();
    const { channel, deliver } = makeFakeChannel();
    const errors: string[] = [];
    serve(stubAgent({ throwError: 'boom' }), channel, {
      store,
      onError: (error: Error): void => {
        errors.push(error.message);
      },
    });

    deliver(inbound());
    await waitFor(() => errors.length === 1);

    expect(errors[0]).toBe('boom');
  });
});
