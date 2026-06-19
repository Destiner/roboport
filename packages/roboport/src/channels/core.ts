import type { Turn } from '@/core';
import type { MaybePromise, Unsub } from '@/triggers/core';

// A provider-agnostic inbound message. Plain data — the live capabilities
// (replying, presence) live on the Conversation, not here. `id` is the transport
// message id (e.g. Telegram message_id), used for replies/drafts/dedup;
// `conversationId` is the stable key for session continuity (e.g. chat id).
interface InboundMessage {
  id: string;
  conversationId: string;
  text: string;
  user?: { id: string; name?: string };
  replyToId?: string;
  raw?: unknown;
}

// The reply path for a single conversation — the half a Trigger lacks. Each
// inbound message arrives with the handle to answer it. `thinking` is an
// optional, channel-defined presence indicator (e.g. Telegram "typing…") that
// returns a stop(); serve brackets each turn with it. Transports with no notion
// of presence omit it.
interface Conversation {
  conversationId: string;
  send(text: string): Promise<void>;
  thinking?(): () => void;
}

type ChannelHandler<In extends InboundMessage, Conv extends Conversation> = (
  message: In,
  conversation: Conv,
) => MaybePromise<void>;

// Turns a running turn's event stream into messages on the conversation. Throwing
// surfaces to serve's onError. The default buffers one reply per turn; a channel
// may ship a richer default (e.g. streaming edits) via Channel.relay. Carries the
// channel's own `In` type (like the other seams), so a custom relay sees the
// transport-specific message without casting through `raw`.
type Relay<In extends InboundMessage, Conv extends Conversation> = (
  turn: Turn,
  conversation: Conv,
  message: In,
) => Promise<void>;

// A bidirectional connection between a transport and an agent. `open` mirrors
// Trigger.start (returns an Unsub) so the same start/stop plumbing applies.
// `handle` is present for webhook transports the host mounts in an HTTP server;
// `relay` is the transport's default reply strategy when the caller supplies none.
interface Channel<
  In extends InboundMessage = InboundMessage,
  Conv extends Conversation = Conversation,
> {
  name: string;
  open(handler: ChannelHandler<In, Conv>): MaybePromise<Unsub>;
  handle?(req: Request): Promise<Response>;
  relay?: Relay<In, Conv>;
}

export type { Channel, ChannelHandler, Conversation, InboundMessage, Relay };
