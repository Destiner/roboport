import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileStorage, MemoryStorage, type TokenSet } from '@/mcp/storage';

const sampleToken: TokenSet = {
  accessToken: 'access-123',
  refreshToken: 'refresh-456',
  expiresAt: 1_700_000_000,
  clientId: 'client',
  redirectUri: 'https://example.test/cb',
};

describe('MemoryStorage', () => {
  test('returns null for an unknown key', async (): Promise<void> => {
    const storage = new MemoryStorage();
    expect(await storage.load('missing')).toBeNull();
  });

  test('round-trips a token set through save/load', async (): Promise<void> => {
    const storage = new MemoryStorage();
    await storage.save('server-a', sampleToken);
    expect(await storage.load('server-a')).toEqual(sampleToken);
  });

  test('isolates entries by key', async (): Promise<void> => {
    const storage = new MemoryStorage();
    await storage.save('server-a', sampleToken);
    expect(await storage.load('server-b')).toBeNull();
  });

  test('clear removes the entry', async (): Promise<void> => {
    const storage = new MemoryStorage();
    await storage.save('server-a', sampleToken);
    await storage.clear('server-a');
    expect(await storage.load('server-a')).toBeNull();
  });
});

describe('FileStorage', () => {
  let workdir: string;
  let filePath: string;

  beforeEach(async (): Promise<void> => {
    workdir = await mkdtemp(join(tmpdir(), 'roboport-storage-'));
    filePath = join(workdir, 'nested', 'mcp-auth.json');
  });

  afterEach(async (): Promise<void> => {
    await rm(workdir, { recursive: true, force: true });
  });

  test('returns null when the file does not exist yet', async (): Promise<void> => {
    const storage = new FileStorage(filePath);
    expect(await storage.load('any')).toBeNull();
  });

  test('creates the parent directory and persists tokens to disk', async (): Promise<void> => {
    const storage = new FileStorage(filePath);
    await storage.save('server-a', sampleToken);

    const onDisk = JSON.parse(await Bun.file(filePath).text()) as Record<
      string,
      TokenSet
    >;
    expect(onDisk['server-a']).toEqual(sampleToken);
  });

  test('writes the file with 0600 permissions', async (): Promise<void> => {
    const storage = new FileStorage(filePath);
    await storage.save('server-a', sampleToken);

    const info = await stat(filePath);
    expect(info.mode & 0o777).toBe(0o600);
  });

  test('load reflects data written by another instance', async (): Promise<void> => {
    const writer = new FileStorage(filePath);
    await writer.save('server-a', sampleToken);

    const reader = new FileStorage(filePath);
    expect(await reader.load('server-a')).toEqual(sampleToken);
  });

  test('clear removes a single entry while preserving others', async (): Promise<void> => {
    const storage = new FileStorage(filePath);
    await storage.save('server-a', sampleToken);
    await storage.save('server-b', { accessToken: 'b' });

    await storage.clear('server-a');

    expect(await storage.load('server-a')).toBeNull();
    expect(await storage.load('server-b')).toEqual({ accessToken: 'b' });
  });

  test('ignores malformed file contents and treats them as empty', async (): Promise<void> => {
    await Bun.write(filePath, 'not json');
    const storage = new FileStorage(filePath);
    expect(await storage.load('server-a')).toBeNull();
  });
});
