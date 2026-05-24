import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

type TokenSet = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  clientId?: string;
  redirectUri?: string;
};

interface OAuthStorage {
  load(key: string): Promise<TokenSet | null>;
  save(key: string, tokens: TokenSet): Promise<void>;
  clear(key: string): Promise<void>;
}

const DEFAULT_PATH = join(homedir(), '.drone', 'mcp-auth.json');

class FileStorage implements OAuthStorage {
  private path: string;
  private cache?: Record<string, TokenSet>;

  constructor(path?: string) {
    this.path = path ?? DEFAULT_PATH;
  }

  private async read(): Promise<Record<string, TokenSet>> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.path, 'utf8');
      this.cache = JSON.parse(raw) as Record<string, TokenSet>;
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  private async write(data: Record<string, TokenSet>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(data, null, 2), 'utf8');
    await chmod(this.path, 0o600);
    this.cache = data;
  }

  async load(key: string): Promise<TokenSet | null> {
    const data = await this.read();
    return data[key] ?? null;
  }

  async save(key: string, tokens: TokenSet): Promise<void> {
    const data = await this.read();
    data[key] = tokens;
    await this.write(data);
  }

  async clear(key: string): Promise<void> {
    const data = await this.read();
    delete data[key];
    await this.write(data);
  }
}

class MemoryStorage implements OAuthStorage {
  private data = new Map<string, TokenSet>();

  async load(key: string): Promise<TokenSet | null> {
    return this.data.get(key) ?? null;
  }

  async save(key: string, tokens: TokenSet): Promise<void> {
    this.data.set(key, tokens);
  }

  async clear(key: string): Promise<void> {
    this.data.delete(key);
  }
}

export { FileStorage, MemoryStorage, type OAuthStorage, type TokenSet };
