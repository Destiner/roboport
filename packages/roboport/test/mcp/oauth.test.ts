import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';

import { captureAuthorizationCode } from '@/mcp/oauth';

describe('captureAuthorizationCode', () => {
  let blocker: Server | undefined;

  afterEach(async (): Promise<void> => {
    const server = blocker;
    blocker = undefined;
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('rejects instead of crashing when the redirect port is in use', async (): Promise<void> => {
    const port = await new Promise<number>((resolve) => {
      const server = createServer();
      server.listen(0, '127.0.0.1', () => {
        blocker = server;
        const address = server.address();
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });

    await expect(
      captureAuthorizationCode(port, 'state', 1000),
    ).rejects.toThrow();
  });
});
