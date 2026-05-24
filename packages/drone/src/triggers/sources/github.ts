import { dispatch, makeBus, subscribe } from '../bus';
import type { Trigger } from '../core';

interface GithubUser {
  login: string;
  id: number;
  type: 'User' | 'Bot' | 'Organization' | string;
}

interface GithubRepository {
  id: number;
  name: string;
  full_name: string;
  owner: GithubUser;
  default_branch: string;
  private: boolean;
  html_url: string;
}

interface GithubLabel {
  id: number;
  name: string;
  color?: string;
}

interface GithubPullRef {
  ref: string;
  sha: string;
  repo: GithubRepository | null;
}

interface GithubPullRequest {
  number: number;
  state: 'open' | 'closed';
  title: string;
  body: string | null;
  draft: boolean;
  merged: boolean;
  head: GithubPullRef;
  base: GithubPullRef;
  user: GithubUser;
  labels: GithubLabel[];
  html_url: string;
}

interface GithubIssue {
  number: number;
  state: 'open' | 'closed';
  title: string;
  body: string | null;
  user: GithubUser;
  labels: GithubLabel[];
  pull_request?: { url: string };
  html_url: string;
}

interface GithubComment {
  id: number;
  body: string;
  user: GithubUser;
  html_url: string;
}

interface GithubPushCommit {
  id: string;
  message: string;
  url: string;
  author: { name: string; email: string; username?: string };
}

interface PullRequestEvent {
  action: string;
  number: number;
  pull_request: GithubPullRequest;
  repository: GithubRepository;
  sender: GithubUser;
}

interface IssuesEvent {
  action: string;
  issue: GithubIssue;
  repository: GithubRepository;
  sender: GithubUser;
}

interface IssueCommentEvent {
  action: string;
  issue: GithubIssue;
  comment: GithubComment;
  repository: GithubRepository;
  sender: GithubUser;
}

interface PushEvent {
  ref: string;
  before: string;
  after: string;
  created: boolean;
  deleted: boolean;
  forced: boolean;
  commits: GithubPushCommit[];
  head_commit: GithubPushCommit | null;
  repository: GithubRepository;
  sender: GithubUser;
  pusher: { name: string; email: string };
}

interface GithubReceiverOptions {
  secret: string;
  deliveryCacheSize?: number;
}

const DEFAULT_DELIVERY_CACHE_SIZE = 1024;

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function verifySignature(
  secret: string,
  body: string,
  signatureHeader: string | null,
): Promise<boolean> {
  if (!signatureHeader) return false;
  const prefix = 'sha256=';
  if (!signatureHeader.startsWith(prefix)) return false;
  const provided = signatureHeader.slice(prefix.length).toLowerCase();
  if (!/^[0-9a-f]+$/.test(provided)) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const computedBytes = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(body),
  );
  const computed = Array.from(new Uint8Array(computedBytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return timingSafeEqual(provided, computed);
}

class DeliveryCache {
  private seen = new Set<string>();
  private order: string[] = [];
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  has(id: string): boolean {
    return this.seen.has(id);
  }

  add(id: string): void {
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.order.push(id);
    while (this.order.length > this.maxSize) {
      const dropped = this.order.shift();
      if (dropped !== undefined) this.seen.delete(dropped);
    }
  }
}

class GithubReceiver {
  private prBus = makeBus<PullRequestEvent>();
  private issueCommentBus = makeBus<IssueCommentEvent>();
  private issuesBus = makeBus<IssuesEvent>();
  private pushBus = makeBus<PushEvent>();
  private readonly secret: string;
  private readonly deliveries: DeliveryCache;

  constructor(options: GithubReceiverOptions) {
    if (!options.secret) {
      throw new Error('GithubReceiver requires a non-empty secret');
    }
    this.secret = options.secret;
    this.deliveries = new DeliveryCache(
      options.deliveryCacheSize ?? DEFAULT_DELIVERY_CACHE_SIZE,
    );
  }

  pullRequest(opts?: { actions?: string[] }): Trigger<PullRequestEvent> {
    const bus = this.prBus;
    const actions = opts?.actions;
    return {
      name: 'github:pull_request',
      start: (emit) =>
        subscribe(
          bus,
          emit,
          actions ? (e): boolean => actions.includes(e.action) : undefined,
        ),
    };
  }

  issueComment(opts?: { actions?: string[] }): Trigger<IssueCommentEvent> {
    const bus = this.issueCommentBus;
    const actions = opts?.actions;
    return {
      name: 'github:issue_comment',
      start: (emit) =>
        subscribe(
          bus,
          emit,
          actions ? (e): boolean => actions.includes(e.action) : undefined,
        ),
    };
  }

  issues(opts?: { actions?: string[] }): Trigger<IssuesEvent> {
    const bus = this.issuesBus;
    const actions = opts?.actions;
    return {
      name: 'github:issues',
      start: (emit) =>
        subscribe(
          bus,
          emit,
          actions ? (e): boolean => actions.includes(e.action) : undefined,
        ),
    };
  }

  push(): Trigger<PushEvent> {
    const bus = this.pushBus;
    return {
      name: 'github:push',
      start: (emit) => subscribe(bus, emit),
    };
  }

  handle = async (req: Request): Promise<Response> => {
    const eventType = req.headers.get('x-github-event');
    if (!eventType) {
      return new Response('missing x-github-event', { status: 400 });
    }

    const body = await req.text();
    const signatureValid = await verifySignature(
      this.secret,
      body,
      req.headers.get('x-hub-signature-256'),
    );
    if (!signatureValid) {
      return new Response('invalid signature', { status: 401 });
    }

    const deliveryId = req.headers.get('x-github-delivery');
    if (deliveryId && this.deliveries.has(deliveryId)) {
      return new Response('duplicate', { status: 200 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return new Response('invalid json', { status: 400 });
    }

    if (deliveryId) this.deliveries.add(deliveryId);

    switch (eventType) {
      case 'pull_request':
        dispatch(this.prBus, payload as PullRequestEvent);
        break;
      case 'issue_comment':
        dispatch(this.issueCommentBus, payload as IssueCommentEvent);
        break;
      case 'issues':
        dispatch(this.issuesBus, payload as IssuesEvent);
        break;
      case 'push':
        dispatch(this.pushBus, payload as PushEvent);
        break;
      default:
        break;
    }
    return new Response('ok', { status: 200 });
  };
}

function githubTrigger(options: GithubReceiverOptions): GithubReceiver {
  return new GithubReceiver(options);
}

export {
  githubTrigger,
  GithubReceiver,
  type GithubComment,
  type GithubIssue,
  type GithubLabel,
  type GithubPullRef,
  type GithubPullRequest,
  type GithubPushCommit,
  type GithubReceiverOptions,
  type GithubRepository,
  type GithubUser,
  type IssueCommentEvent,
  type IssuesEvent,
  type PullRequestEvent,
  type PushEvent,
};
