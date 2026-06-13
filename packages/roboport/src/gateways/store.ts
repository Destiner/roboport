import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Message } from '@/core';
import type { MaybePromise } from '@/triggers/core';

// Durable per-conversation log of *agent* messages (not transport messages),
// keyed by conversationId. serve loads it to seed each turn's context and
// appends the new messages after the turn. A custom store decides the shape it
// persists (faithful messages, terminal text, with timestamps, compacted, …).
interface ConversationStore {
  load(id: string): MaybePromise<Message[] | null>;
  append(id: string, ...messages: Message[]): MaybePromise<void>;
}

// In-memory, process-lifetime store. The default — zero config, lost on restart.
function memoryStore(): ConversationStore {
  const byId = new Map<string, Message[]>();
  return {
    load(id: string): Message[] | null {
      return byId.get(id) ?? null;
    },
    append(id: string, ...messages: Message[]): void {
      const existing = byId.get(id);
      if (existing) existing.push(...messages);
      else byId.set(id, [...messages]);
    },
  };
}

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

// File-backed store: one JSONL file per conversation (one agent message per
// line), appended on each turn. Survives restarts; assumes a single writer per
// conversation, which serve guarantees via per-conversation serialization.
function fileStore(dir: string): ConversationStore {
  function fileFor(id: string): string {
    return join(dir, `${sanitize(id)}.jsonl`);
  }
  return {
    async load(id: string): Promise<Message[] | null> {
      let raw: string;
      try {
        raw = await readFile(fileFor(id), 'utf8');
      } catch {
        return null;
      }
      const messages: Message[] = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          messages.push(JSON.parse(line) as Message);
        } catch {
          // Skip a malformed line rather than fail the whole load.
        }
      }
      return messages;
    },
    async append(id: string, ...messages: Message[]): Promise<void> {
      if (messages.length === 0) return;
      await mkdir(dir, { recursive: true });
      const lines = messages
        .map((message) => JSON.stringify(message))
        .join('\n');
      await appendFile(fileFor(id), `${lines}\n`, 'utf8');
    },
  };
}

export { fileStore, memoryStore, type ConversationStore };
