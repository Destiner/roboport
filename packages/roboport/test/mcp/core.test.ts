import { describe, expect, test } from 'bun:test';

import { Mcp } from '@/mcp/core';

const transport = { type: 'stdio', command: 'true' } as const;

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
