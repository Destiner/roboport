import { Tool, type McpClient } from '@/core';

import { BearerAuth, type AuthProvider } from '../auth';
import { validateMcpName } from '../core';

type Options = {
  url: string;
  serviceAccountToken: string;
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
  baseUrl: string;
  auth: AuthProvider;
}

const EMPTY_OBJECT = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const;

const TOOLS: ToolDef[] = [
  {
    name: 'list_datasources',
    description: 'List all configured Grafana datasources.',
    inputSchema: EMPTY_OBJECT,
    call: (_, ctx) => request(ctx, 'GET', '/api/datasources'),
  },
  {
    name: 'get_datasource',
    description: 'Fetch a single datasource by UID.',
    inputSchema: {
      type: 'object',
      properties: {
        uid: { type: 'string', description: 'Datasource UID.' },
      },
      required: ['uid'],
      additionalProperties: false,
    },
    call: (args, ctx) =>
      request(
        ctx,
        'GET',
        `/api/datasources/uid/${encodeURIComponent(String(args.uid))}`,
      ),
  },
  {
    name: 'query',
    description:
      'Run one or more queries against Grafana datasources via /api/ds/query. Pass the query array as Grafana expects (each item needs refId and datasource.uid).',
    inputSchema: {
      type: 'object',
      properties: {
        queries: {
          type: 'array',
          description:
            'Array of query objects (refId, datasource, expr/range/etc.).',
          items: { type: 'object' },
        },
        from: {
          type: 'string',
          description: 'Range start, e.g. "now-1h" or epoch ms as string.',
        },
        to: {
          type: 'string',
          description: 'Range end, e.g. "now" or epoch ms as string.',
        },
      },
      required: ['queries'],
      additionalProperties: false,
    },
    call: (args, ctx) =>
      request(ctx, 'POST', '/api/ds/query', {
        queries: args.queries,
        from: args.from ?? 'now-1h',
        to: args.to ?? 'now',
      }),
  },
  {
    name: 'search_dashboards',
    description: 'Search dashboards by name, tag, or folder.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Substring match on dashboard title.',
        },
        tag: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by tags.',
        },
        folderUIDs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Limit to specific folder UIDs.',
        },
        limit: { type: 'number', description: 'Max results (default 100).' },
      },
      additionalProperties: false,
    },
    call: (args, ctx): Promise<unknown> => {
      const params = new URLSearchParams();
      params.set('type', 'dash-db');
      if (typeof args.query === 'string') params.set('query', args.query);
      if (typeof args.limit === 'number')
        params.set('limit', String(args.limit));
      for (const tag of (args.tag as string[] | undefined) ?? [])
        params.append('tag', tag);
      for (const uid of (args.folderUIDs as string[] | undefined) ?? [])
        params.append('folderUIDs', uid);
      return request(ctx, 'GET', `/api/search?${params.toString()}`);
    },
  },
  {
    name: 'get_dashboard',
    description: 'Fetch a dashboard JSON by UID.',
    inputSchema: {
      type: 'object',
      properties: {
        uid: { type: 'string', description: 'Dashboard UID.' },
      },
      required: ['uid'],
      additionalProperties: false,
    },
    call: (args, ctx) =>
      request(
        ctx,
        'GET',
        `/api/dashboards/uid/${encodeURIComponent(String(args.uid))}`,
      ),
  },
  {
    name: 'list_folders',
    description: 'List dashboard folders.',
    inputSchema: EMPTY_OBJECT,
    call: (_, ctx) => request(ctx, 'GET', '/api/folders'),
  },
  {
    name: 'list_alert_rules',
    description: 'List provisioned alert rules.',
    inputSchema: EMPTY_OBJECT,
    call: (_, ctx) => request(ctx, 'GET', '/api/v1/provisioning/alert-rules'),
  },
];

async function request(
  ctx: RequestContext,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<unknown> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    authorization: await ctx.auth.getHeader(),
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Grafana ${method} ${path} failed: ${res.status} ${text}`);
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

class Mcp implements McpClient {
  private baseUrl: string;
  private auth: AuthProvider;
  private nameSpace: string;
  private deferred: boolean;

  constructor(opts: Options) {
    this.baseUrl = opts.url.replace(/\/$/, '');
    this.auth = new BearerAuth(opts.serviceAccountToken);
    this.nameSpace = opts.name ?? 'grafana';
    validateMcpName(this.nameSpace);
    this.deferred = opts.deferred ?? true;
  }

  async connect(): Promise<Tool[]> {
    const ctx: RequestContext = { baseUrl: this.baseUrl, auth: this.auth };
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
