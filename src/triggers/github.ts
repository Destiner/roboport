import { dispatch, makeBus, subscribe } from './bus';
import type { Trigger } from './core';

type Json = Record<string, unknown>;

interface PullRequestEvent {
  action: string;
  number: number;
  pull_request: Json;
  repository: Json;
  sender: Json;
}

interface IssueCommentEvent {
  action: string;
  issue: Json;
  comment: Json;
  repository: Json;
  sender: Json;
}

interface IssuesEvent {
  action: string;
  issue: Json;
  repository: Json;
  sender: Json;
}

interface PushEvent {
  ref: string;
  before: string;
  after: string;
  commits: Json[];
  repository: Json;
  sender: Json;
}

class GithubReceiver {
  private prBus = makeBus<PullRequestEvent>();
  private issueCommentBus = makeBus<IssueCommentEvent>();
  private issuesBus = makeBus<IssuesEvent>();
  private pushBus = makeBus<PushEvent>();

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
    let payload: Json;
    try {
      payload = (await req.json()) as Json;
    } catch {
      return new Response('invalid json', { status: 400 });
    }
    switch (eventType) {
      case 'pull_request':
        dispatch(this.prBus, payload as unknown as PullRequestEvent);
        break;
      case 'issue_comment':
        dispatch(this.issueCommentBus, payload as unknown as IssueCommentEvent);
        break;
      case 'issues':
        dispatch(this.issuesBus, payload as unknown as IssuesEvent);
        break;
      case 'push':
        dispatch(this.pushBus, payload as unknown as PushEvent);
        break;
      default:
        break;
    }
    return new Response('ok', { status: 200 });
  };
}

function githubTrigger(): GithubReceiver {
  return new GithubReceiver();
}

export {
  githubTrigger,
  GithubReceiver,
  type IssueCommentEvent,
  type IssuesEvent,
  type PullRequestEvent,
  type PushEvent,
};
