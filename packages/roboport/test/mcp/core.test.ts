import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Mcp } from '@/mcp/core';

const transport = { type: 'stdio', command: 'true' } as const;

// Minimal stdio JSON-RPC server: enough of the MCP handshake to drive the
// transport (initialize, tools/list, tools/call). `\\n` keeps a literal newline
// in the emitted script rather than a newline in this source file.
const STDIO_SERVER = `
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx = buffer.indexOf('\\n');
  while (idx !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    idx = buffer.indexOf('\\n');
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === undefined || msg.id === null) continue;
    let result = {};
    if (msg.method === 'initialize') {
      result = { protocolVersion: '2024-11-05', capabilities: {} };
    } else if (msg.method === 'tools/list') {
      result = { tools: [{ name: 'echo', description: 'echoes text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] };
    } else if (msg.method === 'tools/call') {
      result = { content: [{ type: 'text', text: msg.params.arguments.text }] };
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
  }
});
`;

describe('Mcp name validation', () => {
  test('accepts names made of letters, digits, underscores, and hyphens', () => {
    expect(() => new Mcp({ name: 'my-server_1', transport })).not.toThrow();
  });

  test('rejects names with characters that break tool names', () => {
    expect(() => new Mcp({ name: 'github.com/acme', transport })).toThrow(
      /Invalid MCP name/,
    );
    expect(() => new Mcp({ name: 'has space', transport })).toThrow(
      /Invalid MCP name/,
    );
    expect(() => new Mcp({ name: '', transport })).toThrow(/Invalid MCP name/);
  });
});

describe('Mcp stdio transport', () => {
  let dir: string;
  let scriptPath: string;

  beforeEach(async (): Promise<void> => {
    dir = await mkdtemp(join(tmpdir(), 'roboport-mcp-'));
    scriptPath = join(dir, 'server.mjs');
    await writeFile(scriptPath, STDIO_SERVER);
  });

  afterEach(async (): Promise<void> => {
    await rm(dir, { recursive: true, force: true });
  });

  test('connects, lists, and calls a tool over stdio', async (): Promise<void> => {
    const mcp = new Mcp({
      name: 'test',
      transport: {
        type: 'stdio',
        command: process.execPath,
        args: [scriptPath],
      },
    });

    const tools = await mcp.connect();
    try {
      expect(tools).toHaveLength(1);
      const echo = tools[0];
      expect(echo?.name).toBe('mcp__test__echo');
      const result = await echo?.execute({ text: 'hi there' }, {} as never);
      expect(result).toBe('hi there');
    } finally {
      await mcp.disconnect();
    }
  });

  test('rejects connect when the command cannot be spawned', async (): Promise<void> => {
    const mcp = new Mcp({
      name: 'test',
      transport: {
        type: 'stdio',
        command: 'roboport-no-such-binary-xyz',
      },
    });

    await expect(mcp.connect()).rejects.toThrow();
  });
});
