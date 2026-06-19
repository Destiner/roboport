import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fileStore, memoryStore } from '@/channels';
import type { Message } from '@/core';

function user(text: string): Message {
  return { role: 'user', content: text };
}
function assistant(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

describe('memoryStore', () => {
  test('append then load round-trips, accumulating across calls', async () => {
    const store = memoryStore();
    expect(await store.load('a')).toBeNull();

    await store.append('a', user('hi'));
    await store.append('a', assistant('hello'));

    expect(await store.load('a')).toEqual([user('hi'), assistant('hello')]);
    expect(await store.load('b')).toBeNull();
  });

  test('keeps conversations separate', async () => {
    const store = memoryStore();
    await store.append('a', user('one'));
    await store.append('b', user('two'));

    expect(await store.load('a')).toEqual([user('one')]);
    expect(await store.load('b')).toEqual([user('two')]);
  });
});

describe('fileStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'roboport-store-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('persists messages as JSONL and reloads them', async () => {
    const store = fileStore(dir);
    expect(await store.load('42')).toBeNull();

    await store.append('42', user('hi'));
    await store.append('42', assistant('hello'));

    const reloaded = fileStore(dir);
    expect(await reloaded.load('42')).toEqual([user('hi'), assistant('hello')]);
  });

  test('sanitizes conversation ids into safe filenames', async () => {
    const store = fileStore(dir);
    await store.append('-100/../etc', user('hi'));
    expect(await store.load('-100/../etc')).toEqual([user('hi')]);
  });

  test('does not merge ids that share a sanitized prefix', async () => {
    const store = fileStore(dir);
    await store.append('a/b', user('slash'));
    await store.append('a:b', user('colon'));
    expect(await store.load('a/b')).toEqual([user('slash')]);
    expect(await store.load('a:b')).toEqual([user('colon')]);
  });

  test('skips malformed lines rather than failing the load', async () => {
    const store = fileStore(dir);
    await store.append('7', user('hi'));
    // Append into the file the store actually reads (name includes a hash).
    const [file] = await readdir(dir);
    if (!file) throw new Error('expected a store file');
    await writeFile(join(dir, file), 'not json\n', { flag: 'a' });
    await store.append('7', assistant('hello'));

    expect(await store.load('7')).toEqual([user('hi'), assistant('hello')]);
  });
});
