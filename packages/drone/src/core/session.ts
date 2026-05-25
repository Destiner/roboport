import type { Message, TextPart } from './message';

// User-facing event stream for a single turn. Token-level deltas (`text-delta`,
// `thinking-delta`) arrive as the model emits them; the matching completion
// events (`text`, `thinking`) fire once a block is fully assembled. Tool calls
// and results stream between model round-trips. `turn-end` marks the loop
// exiting (no more tool_use response from the model).
type TurnEvent =
  | { type: 'message-start' }
  | { type: 'text-delta'; text: string }
  | { type: 'text'; text: string }
  | { type: 'thinking-delta'; text: string }
  | { type: 'thinking'; text: string; signature?: string }
  | {
      type: 'tool-call';
      toolCallId: string;
      toolName: string;
      input: unknown;
    }
  | {
      type: 'tool-result';
      toolCallId: string;
      toolName: string;
      output: unknown;
      isError: boolean;
    }
  | {
      type: 'message-end';
      usage: { inputTokens: number; outputTokens: number };
    }
  | { type: 'turn-end' }
  | { type: 'error'; error: Error };

type TurnEmit = (event: TurnEvent) => void;

interface TurnRunContext {
  emit: TurnEmit;
  signal: AbortSignal;
}

type TurnRunner = (ctx: TurnRunContext) => Promise<Message[]>;

// A Turn is both an async iterable of events and a thenable resolving to the
// post-turn message list. Iterating gives you streaming UX; awaiting gives you
// the final state without consuming events.
class Turn implements AsyncIterable<TurnEvent>, PromiseLike<Message[]> {
  private queue: TurnEvent[] = [];
  private waiters: ((value: IteratorResult<TurnEvent>) => void)[] = [];
  private ended = false;
  private iterated = false;
  private resultPromise: Promise<Message[]>;
  private abortController = new AbortController();

  constructor(runner: TurnRunner) {
    this.resultPromise = runner({
      emit: (event) => this.emit(event),
      signal: this.abortController.signal,
    }).then(
      (messages) => {
        this.close();
        return messages;
      },
      (error: unknown) => {
        this.close();
        throw error;
      },
    );
    // Suppress unhandled-rejection warnings when the caller only iterates.
    this.resultPromise.catch(() => {});
  }

  private emit(event: TurnEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  private close(): void {
    this.ended = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.({ value: undefined, done: true } as IteratorResult<TurnEvent>);
    }
  }

  abort(reason?: string): void {
    this.abortController.abort(reason);
  }

  [Symbol.asyncIterator](): AsyncIterator<TurnEvent> {
    if (this.iterated) {
      throw new Error('Turn can only be iterated once.');
    }
    this.iterated = true;
    return {
      next: (): Promise<IteratorResult<TurnEvent>> => {
        if (this.queue.length > 0) {
          const value = this.queue.shift() as TurnEvent;
          return Promise.resolve({ value, done: false });
        }
        if (this.ended) {
          return Promise.resolve({
            value: undefined,
            done: true,
          } as IteratorResult<TurnEvent>);
        }
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }

  then<TResult1 = Message[], TResult2 = never>(
    onfulfilled?:
      | ((value: Message[]) => TResult1 | PromiseLike<TResult1>)
      | null
      | undefined,
    onrejected?:
      | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
      | null
      | undefined,
  ): PromiseLike<TResult1 | TResult2> {
    return this.resultPromise.then(onfulfilled, onrejected);
  }
}

interface SessionInternals {
  send(prompt: string | TextPart[]): Turn;
  close(): Promise<void>;
}

class Session implements AsyncDisposable {
  private internals: SessionInternals;
  private state: { messages: Message[] };

  constructor(internals: SessionInternals, state: { messages: Message[] }) {
    this.internals = internals;
    this.state = state;
  }

  get messages(): readonly Message[] {
    return this.state.messages;
  }

  send(prompt: string | TextPart[]): Turn {
    return this.internals.send(prompt);
  }

  async close(): Promise<void> {
    await this.internals.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

export {
  Session,
  Turn,
  type SessionInternals,
  type TurnEmit,
  type TurnEvent,
  type TurnRunContext,
  type TurnRunner,
};
