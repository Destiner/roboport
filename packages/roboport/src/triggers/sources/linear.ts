import { dispatch, makeBus, subscribe } from '../bus';
import type { Trigger } from '../core';

type Json = Record<string, unknown>;

type LinearAction = 'create' | 'update' | 'remove';

interface LinearWebhook {
  action: LinearAction;
  type: string;
  data: Json;
  url?: string;
  createdAt?: string;
  organizationId?: string;
  webhookId?: string;
  webhookTimestamp?: number;
}

interface LinearIssueEvent extends LinearWebhook {
  type: 'Issue';
}

interface LinearCommentEvent extends LinearWebhook {
  type: 'Comment';
}

interface LinearProjectEvent extends LinearWebhook {
  type: 'Project';
}

class LinearReceiver {
  private issueBus = makeBus<LinearIssueEvent>();
  private commentBus = makeBus<LinearCommentEvent>();
  private projectBus = makeBus<LinearProjectEvent>();

  issue(opts?: { actions?: LinearAction[] }): Trigger<LinearIssueEvent> {
    const bus = this.issueBus;
    const actions = opts?.actions;
    return {
      name: 'linear:issue',
      start: (emit) =>
        subscribe(
          bus,
          emit,
          actions ? (e): boolean => actions.includes(e.action) : undefined,
        ),
    };
  }

  comment(opts?: { actions?: LinearAction[] }): Trigger<LinearCommentEvent> {
    const bus = this.commentBus;
    const actions = opts?.actions;
    return {
      name: 'linear:comment',
      start: (emit) =>
        subscribe(
          bus,
          emit,
          actions ? (e): boolean => actions.includes(e.action) : undefined,
        ),
    };
  }

  project(opts?: { actions?: LinearAction[] }): Trigger<LinearProjectEvent> {
    const bus = this.projectBus;
    const actions = opts?.actions;
    return {
      name: 'linear:project',
      start: (emit) =>
        subscribe(
          bus,
          emit,
          actions ? (e): boolean => actions.includes(e.action) : undefined,
        ),
    };
  }

  handle = async (req: Request): Promise<Response> => {
    let payload: LinearWebhook;
    try {
      payload = (await req.json()) as LinearWebhook;
    } catch {
      return new Response('invalid json', { status: 400 });
    }
    switch (payload.type) {
      case 'Issue':
        dispatch(this.issueBus, payload as LinearIssueEvent);
        break;
      case 'Comment':
        dispatch(this.commentBus, payload as LinearCommentEvent);
        break;
      case 'Project':
        dispatch(this.projectBus, payload as LinearProjectEvent);
        break;
      default:
        break;
    }
    return new Response('ok', { status: 200 });
  };
}

function linear(): LinearReceiver {
  return new LinearReceiver();
}

export {
  linear,
  LinearReceiver,
  type LinearAction,
  type LinearCommentEvent,
  type LinearIssueEvent,
  type LinearProjectEvent,
  type LinearWebhook,
};
