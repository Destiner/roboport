import { Tool, type McpClient } from '@/core';

import type { AuthProvider } from './auth';

type StdioTransportConfig = {
  type: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

type HttpTransportConfig = {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
  auth?: AuthProvider;
};

type McpTransportConfig = StdioTransportConfig | HttpTransportConfig;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface RemoteTool {
  name: string;
  description?: string;
  inputSchema: object;
}

interface ContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

interface ToolCallResult {
  content: ContentBlock[];
  isError?: boolean;
}

const PROTOCOL_VERSION = '2024-11-05';

interface Transport {
  start(): Promise<void>;
  stop(): Promise<void>;
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
}

class StdioTransport implements Transport {
  private config: StdioTransportConfig;
  private proc?: ReturnType<typeof Bun.spawn>;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >();
  private buffer = '';

  constructor(config: StdioTransportConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    this.proc = Bun.spawn([this.config.command, ...(this.config.args ?? [])], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'inherit',
      env: { ...process.env, ...this.config.env } as Record<string, string>,
    });
    void this.readLoop();
  }

  private async readLoop(): Promise<void> {
    if (!this.proc?.stdout) return;
    const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      this.buffer += decoder.decode(value, { stream: true });
      let idx = this.buffer.indexOf('\n');
      while (idx !== -1) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (line) this.handleLine(line);
        idx = this.buffer.indexOf('\n');
      }
    }
    for (const { reject } of this.pending.values()) {
      reject(new Error('MCP stdio transport closed.'));
    }
    this.pending.clear();
  }

  private handleLine(line: string): void {
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return;
    }
    if (msg.id === null || msg.id === undefined) return;
    const id = typeof msg.id === 'string' ? parseInt(msg.id, 10) : msg.id;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (msg.error) {
      pending.reject(
        new Error(`MCP error ${msg.error.code}: ${msg.error.message}`),
      );
    } else {
      pending.resolve(msg.result);
    }
  }

  async stop(): Promise<void> {
    this.proc?.kill();
    if (this.proc) await this.proc.exited;
    this.proc = undefined;
  }

  private writeLine(line: string): void {
    const sink = this.proc?.stdin;
    if (!sink || typeof sink === 'number') {
      throw new Error('MCP stdio transport not started.');
    }
    sink.write(`${line}\n`);
    sink.flush();
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.writeLine(JSON.stringify(req));
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const req: JsonRpcRequest = { jsonrpc: '2.0', method, params };
    this.writeLine(JSON.stringify(req));
  }
}

class HttpTransport implements Transport {
  private config: HttpTransportConfig;
  private nextId = 1;
  private sessionId?: string;

  constructor(config: HttpTransportConfig) {
    this.config = config;
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  private async buildHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(this.config.headers ?? {}),
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    if (this.config.auth) {
      headers['authorization'] = await this.config.auth.getHeader();
    }
    return headers;
  }

  private async send(
    body: JsonRpcRequest,
    expectId: number | undefined,
  ): Promise<unknown> {
    const res = await this.attempt(body);
    if (res.status === 401 && this.config.auth?.onUnauthorized) {
      await res.body?.cancel();
      await this.config.auth.onUnauthorized();
      const retried = await this.attempt(body);
      return this.consume(retried, expectId);
    }
    return this.consume(res, expectId);
  }

  private async attempt(body: JsonRpcRequest): Promise<Response> {
    return fetch(this.config.url, {
      method: 'POST',
      headers: await this.buildHeaders(),
      body: JSON.stringify(body),
    });
  }

  private async consume(
    res: Response,
    expectId: number | undefined,
  ): Promise<unknown> {
    if (!res.ok) {
      throw new Error(`MCP HTTP error ${res.status}: ${await res.text()}`);
    }

    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;

    if (expectId === undefined) {
      await res.body?.cancel();
      return undefined;
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      return this.readSseResponse(res, expectId);
    }
    const json = (await res.json()) as JsonRpcResponse;
    return this.unwrap(json, expectId);
  }

  private async readSseResponse(
    res: Response,
    expectId: number,
  ): Promise<unknown> {
    const text = await res.text();
    for (const block of text.split(/\n\n+/)) {
      const dataLines = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart());
      if (dataLines.length === 0) continue;
      const payload = dataLines.join('\n');
      let json: JsonRpcResponse;
      try {
        json = JSON.parse(payload) as JsonRpcResponse;
      } catch {
        continue;
      }
      const id = typeof json.id === 'string' ? parseInt(json.id, 10) : json.id;
      if (id === expectId) return this.unwrap(json, expectId);
    }
    throw new Error('MCP HTTP SSE response missing expected id.');
  }

  private unwrap(json: JsonRpcResponse, expectId: number): unknown {
    if (json.error) {
      throw new Error(`MCP error ${json.error.code}: ${json.error.message}`);
    }
    const id = typeof json.id === 'string' ? parseInt(json.id, 10) : json.id;
    if (id !== expectId) {
      throw new Error(`MCP HTTP response id mismatch (got ${id}).`);
    }
    return json.result;
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    return this.send(req, id);
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const req: JsonRpcRequest = { jsonrpc: '2.0', method, params };
    await this.send(req, undefined);
  }
}

function formatContent(content: ContentBlock[]): string {
  if (content.length === 1 && content[0]?.type === 'text') {
    return content[0].text ?? '';
  }
  return content
    .map((block) =>
      block.type === 'text' ? (block.text ?? '') : JSON.stringify(block),
    )
    .join('\n');
}

class Mcp implements McpClient {
  name: string;
  transport: McpTransportConfig;
  deferred: boolean;
  private connection?: Transport;

  constructor({
    name,
    transport,
    deferred,
  }: {
    name: string;
    transport: McpTransportConfig;
    deferred?: boolean;
  }) {
    this.name = name;
    this.transport = transport;
    this.deferred = deferred ?? true;
  }

  async connect(): Promise<Tool[]> {
    const connection: Transport =
      this.transport.type === 'stdio'
        ? new StdioTransport(this.transport)
        : new HttpTransport(this.transport);

    this.connection = connection;
    await connection.start();

    await connection.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'roboport', version: '0.1.0' },
    });
    await connection.notify('notifications/initialized');

    const result = (await connection.request('tools/list')) as {
      tools: RemoteTool[];
    };
    return result.tools.map((remote) => this.wrap(remote));
  }

  async disconnect(): Promise<void> {
    if (!this.connection) return;
    const connection = this.connection;
    this.connection = undefined;
    await connection.stop();
  }

  private wrap(remote: RemoteTool): Tool {
    return new Tool({
      name: `mcp__${this.name}__${remote.name}`,
      description: remote.description ?? `${this.name}.${remote.name}`,
      jsonSchema: remote.inputSchema,
      deferred: this.deferred,
      execute: async (input): Promise<string> => {
        if (!this.connection) {
          throw new Error(`MCP "${this.name}" is not connected.`);
        }
        const result = (await this.connection.request('tools/call', {
          name: remote.name,
          arguments: input,
        })) as ToolCallResult;
        const text = formatContent(result.content);
        if (result.isError) throw new Error(text);
        return text;
      },
    });
  }
}

export {
  Mcp,
  type McpTransportConfig,
  type StdioTransportConfig,
  type HttpTransportConfig,
};
