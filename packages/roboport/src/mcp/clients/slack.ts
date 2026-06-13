import { Tool, type McpClient } from '@/core';

import { BearerAuth, type AuthProvider } from '../auth';

type Options = {
  botToken: string;
  name?: string;
  deferred?: boolean;
};

interface ToolDef {
  name: string;
  description: string;
  inputSchema: object;
  call(args: Record<string, unknown>, ctx: RequestContext): Promise<unknown>;
}

interface RequestContext {
  auth: AuthProvider;
}

const SLACK_API_URL = 'https://slack.com/api';

const TOOLS: ToolDef[] = [
  {
    name: 'post_message',
    description: 'Post a message to a Slack channel.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          description: 'Channel ID (e.g. C012AB3CD) or name (e.g. #general).',
        },
        text: { type: 'string', description: 'Message text.' },
      },
      required: ['channel', 'text'],
      additionalProperties: false,
    },
    call: (args, ctx) =>
      request(ctx, 'chat.postMessage', {
        channel: args.channel,
        text: args.text,
      }),
  },
  {
    name: 'reply_in_thread',
    description: 'Reply to an existing message thread in a Slack channel.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel ID or name.' },
        thread_ts: {
          type: 'string',
          description: 'Timestamp (ts) of the parent message to reply to.',
        },
        text: { type: 'string', description: 'Reply text.' },
      },
      required: ['channel', 'thread_ts', 'text'],
      additionalProperties: false,
    },
    call: (args, ctx) =>
      request(ctx, 'chat.postMessage', {
        channel: args.channel,
        thread_ts: args.thread_ts,
        text: args.text,
      }),
  },
  {
    name: 'list_channels',
    description: 'List channels in the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        types: {
          type: 'string',
          description:
            'Comma-separated channel types (default "public_channel").',
        },
        limit: { type: 'number', description: 'Max results (default 100).' },
        cursor: { type: 'string', description: 'Pagination cursor.' },
        exclude_archived: {
          type: 'boolean',
          description: 'Omit archived channels (default true).',
        },
      },
      additionalProperties: false,
    },
    call: (args, ctx) =>
      request(ctx, 'conversations.list', {
        types: args.types ?? 'public_channel',
        limit: args.limit ?? 100,
        cursor: args.cursor,
        exclude_archived: args.exclude_archived ?? true,
      }),
  },
  {
    name: 'get_channel_history',
    description: 'Fetch recent messages from a channel.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel ID.' },
        limit: { type: 'number', description: 'Max messages (default 100).' },
        cursor: { type: 'string', description: 'Pagination cursor.' },
        oldest: {
          type: 'string',
          description: 'Only messages after this ts.',
        },
        latest: {
          type: 'string',
          description: 'Only messages before this ts.',
        },
      },
      required: ['channel'],
      additionalProperties: false,
    },
    call: (args, ctx) =>
      request(ctx, 'conversations.history', {
        channel: args.channel,
        limit: args.limit ?? 100,
        cursor: args.cursor,
        oldest: args.oldest,
        latest: args.latest,
      }),
  },
  {
    name: 'list_users',
    description: 'List users in the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default 100).' },
        cursor: { type: 'string', description: 'Pagination cursor.' },
      },
      additionalProperties: false,
    },
    call: (args, ctx) =>
      request(ctx, 'users.list', {
        limit: args.limit ?? 100,
        cursor: args.cursor,
      }),
  },
  {
    name: 'get_user',
    description: 'Fetch a single user by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        user: { type: 'string', description: 'User ID (e.g. U012AB3CD).' },
      },
      required: ['user'],
      additionalProperties: false,
    },
    call: (args, ctx) => request(ctx, 'users.info', { user: args.user }),
  },
  {
    name: 'add_reaction',
    description: 'Add an emoji reaction to a message.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel ID.' },
        timestamp: {
          type: 'string',
          description: 'Timestamp (ts) of the target message.',
        },
        name: {
          type: 'string',
          description: 'Emoji name without colons (e.g. "thumbsup").',
        },
      },
      required: ['channel', 'timestamp', 'name'],
      additionalProperties: false,
    },
    call: (args, ctx) =>
      request(ctx, 'reactions.add', {
        channel: args.channel,
        timestamp: args.timestamp,
        name: args.name,
      }),
  },
];

async function request(
  ctx: RequestContext,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    body.set(key, String(value));
  }
  const res = await fetch(`${SLACK_API_URL}/${method}`, {
    method: 'POST',
    headers: {
      authorization: await ctx.auth.getHeader(),
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  // Slack returns HTTP 200 with `{ ok: false, error }` for API-level failures.
  const json = (await res.json()) as { ok: boolean; error?: string };
  if (!json.ok) {
    throw new Error(`Slack ${method} failed: ${json.error ?? res.status}`);
  }
  return json;
}

class Mcp implements McpClient {
  private auth: AuthProvider;
  private nameSpace: string;
  private deferred: boolean;

  constructor(opts: Options) {
    this.auth = new BearerAuth(opts.botToken);
    this.nameSpace = opts.name ?? 'slack';
    this.deferred = opts.deferred ?? true;
  }

  async connect(): Promise<Tool[]> {
    const ctx: RequestContext = { auth: this.auth };
    return TOOLS.map(
      (def) =>
        new Tool({
          name: `mcp__${this.nameSpace}__${def.name}`,
          description: def.description,
          jsonSchema: def.inputSchema,
          deferred: this.deferred,
          execute: async (input): Promise<string> => {
            const args = (input ?? {}) as Record<string, unknown>;
            const result = await def.call(args, ctx);
            return typeof result === 'string' ? result : JSON.stringify(result);
          },
        }),
    );
  }

  async disconnect(): Promise<void> {}
}

export default Mcp;
