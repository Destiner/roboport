import { dispatch, makeBus, subscribe } from '../bus';
import type { Trigger } from '../core';
import { hmacSha256Hex, SeenCache, timingSafeEqual } from '../shared';

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

interface GithubReviewComment extends GithubComment {
  path: string;
  line: number | null;
  start_line: number | null;
  commit_id: string;
  diff_hunk: string;
  pull_request_review_id: number | null;
  in_reply_to_id?: number;
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

interface PullRequestReviewCommentEvent {
  action: string;
  comment: GithubReviewComment;
  pull_request: GithubPullRequest;
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
  const computed = await hmacSha256Hex(secret, body);
  return timingSafeEqual(provided, computed);
}

class GithubReceiver {
  private prBus = makeBus<PullRequestEvent>();
  private issueCommentBus = makeBus<IssueCommentEvent>();
  private reviewCommentBus = makeBus<PullRequestReviewCommentEvent>();
  private issuesBus = makeBus<IssuesEvent>();
  private pushBus = makeBus<PushEvent>();
  private readonly secret: string;
  private readonly deliveries: SeenCache<string>;

  constructor(options: GithubReceiverOptions) {
    if (!options.secret) {
      throw new Error('GithubReceiver requires a non-empty secret');
    }
    this.secret = options.secret;
    this.deliveries = new SeenCache(
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

  pullRequestReviewComment(opts?: {
    actions?: string[];
  }): Trigger<PullRequestReviewCommentEvent> {
    const bus = this.reviewCommentBus;
    const actions = opts?.actions;
    return {
      name: 'github:pull_request_review_comment',
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

    switch (eventType) {
      case 'pull_request':
        dispatch(this.prBus, payload as PullRequestEvent);
        break;
      case 'issue_comment':
        dispatch(this.issueCommentBus, payload as IssueCommentEvent);
        break;
      case 'pull_request_review_comment':
        dispatch(
          this.reviewCommentBus,
          payload as PullRequestReviewCommentEvent,
        );
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
    if (deliveryId) this.deliveries.add(deliveryId);
    return new Response('ok', { status: 200 });
  };
}

function github(options: GithubReceiverOptions): GithubReceiver {
  return new GithubReceiver(options);
}

export {
  github,
  GithubReceiver,
  type GithubComment,
  type GithubIssue,
  type GithubLabel,
  type GithubPullRef,
  type GithubPullRequest,
  type GithubPushCommit,
  type GithubReceiverOptions,
  type GithubRepository,
  type GithubReviewComment,
  type GithubUser,
  type IssueCommentEvent,
  type IssuesEvent,
  type PullRequestEvent,
  type PullRequestReviewCommentEvent,
  type PushEvent,
};
