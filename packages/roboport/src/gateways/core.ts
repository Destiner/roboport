import type { Turn } from '@/core';
import type { MaybePromise, Unsub } from '@/triggers/core';

// A provider-agnostic inbound message. Plain data — the live capabilities
// (replying, presence) live on the Channel, not here. `id` is the transport
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
// optional, gateway-defined presence indicator (e.g. Telegram "typing…") that
// returns a stop(); serve brackets each turn with it. Transports with no notion
// of presence omit it.
interface Channel {
  conversationId: string;
  send(text: string): Promise<void>;
  thinking?(): () => void;
}

type GatewayHandler<In extends InboundMessage, Ch extends Channel> = (
  message: In,
  channel: Ch,
) => MaybePromise<void>;

// Turns a running turn's event stream into messages on the channel. Throwing
// surfaces to serve's onError. The default buffers one reply per turn; a gateway
// may ship a richer default (e.g. streaming edits) via Gateway.relay.
type Relay<Ch extends Channel> = (
  turn: Turn,
  channel: Ch,
  message: InboundMessage,
) => Promise<void>;

// A bidirectional connection between a transport and an agent. `open` mirrors
// Trigger.start (returns an Unsub) so the same start/stop plumbing applies.
// `handle` is present for webhook transports the host mounts in an HTTP server;
// `relay` is the transport's default reply strategy when the caller supplies none.
interface Gateway<
  In extends InboundMessage = InboundMessage,
  Ch extends Channel = Channel,
> {
  name: string;
  open(handler: GatewayHandler<In, Ch>): MaybePromise<Unsub>;
  handle?(req: Request): Promise<Response>;
  relay?: Relay<Ch>;
}

export type { Channel, Gateway, GatewayHandler, InboundMessage, Relay };
