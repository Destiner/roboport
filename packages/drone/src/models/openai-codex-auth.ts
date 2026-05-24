import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { env } from '@/env';

const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CHATGPT_AUTH_CLAIM = 'https://api.openai.com/auth';
const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';

type OpenAICodexAuthOptions = {
  type: 'codex';
  authFile?: string;
  baseUrl?: string;
};

type CodexTokenData = {
  id_token?: string | { raw_jwt?: string };
  access_token?: string;
  refresh_token?: string;
  account_id?: string;
};

type CodexAuthFile = {
  auth_mode?: string;
  OPENAI_API_KEY?: string;
  tokens?: CodexTokenData;
  last_refresh?: string;
};

type CodexAuthHeaders = {
  authorization: string;
  accountId: string;
  isFedrampAccount: boolean;
};

function expandPath(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

function defaultAuthFiles(): string[] {
  const files: string[] = [];
  const explicit = env.openaiCodexAuthFile;
  if (explicit) files.push(expandPath(explicit));
  const codexHome = env.codexHome;
  if (codexHome) files.push(join(expandPath(codexHome), 'auth.json'));
  files.push(join(homedir(), '.codex', 'auth.json'));
  files.push(join(homedir(), '.drone', 'openai-codex-auth.json'));
  return files;
}

function parseJwtPayload(token: string): Record<string, unknown> | undefined {
  const [, payload] = token.split('.');
  if (!payload) return undefined;
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      '=',
    );
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return undefined;
  }
}

function jwtExpiresSoon(token: string): boolean {
  const payload = parseJwtPayload(token);
  const exp = typeof payload?.exp === 'number' ? payload.exp : undefined;
  if (exp === undefined) return false;
  return exp * 1000 <= Date.now() + 60_000;
}

function extractRawIdToken(tokens: CodexTokenData): string | undefined {
  if (typeof tokens.id_token === 'string') return tokens.id_token;
  return tokens.id_token?.raw_jwt;
}

function extractAccountId(tokens: CodexTokenData): string | undefined {
  if (tokens.account_id) return tokens.account_id;
  if (!tokens.access_token) return undefined;
  const payload = parseJwtPayload(tokens.access_token);
  const auth = payload?.[CHATGPT_AUTH_CLAIM];
  if (typeof auth !== 'object' || auth === null) return undefined;
  const accountId = (auth as { chatgpt_account_id?: unknown })
    .chatgpt_account_id;
  return typeof accountId === 'string' && accountId.length > 0
    ? accountId
    : undefined;
}

function extractFedrampFlag(tokens: CodexTokenData): boolean {
  const token = tokens.access_token ?? extractRawIdToken(tokens);
  if (!token) return false;
  const payload = parseJwtPayload(token);
  const auth = payload?.[CHATGPT_AUTH_CLAIM];
  if (typeof auth !== 'object' || auth === null) return false;
  return (
    (auth as { chatgpt_account_is_fedramp?: unknown })
      .chatgpt_account_is_fedramp === true
  );
}

async function readJson(path: string): Promise<CodexAuthFile> {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw) as CodexAuthFile;
}

async function writeJson(path: string, data: CodexAuthFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await chmod(path, 0o600);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withAuthFileLock<T>(
  authFile: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockDir = `${authFile}.lock`;
  const deadline = Date.now() + 10_000;

  while (true) {
    try {
      await mkdir(lockDir, { mode: 0o700 });
      break;
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? (error as { code?: unknown }).code
          : undefined;
      if (code !== 'EEXIST' || Date.now() >= deadline) throw error;
      await sleep(100);
    }
  }

  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

async function findAuthFile(authFile?: string): Promise<string> {
  if (authFile) return resolve(expandPath(authFile));

  for (const candidate of defaultAuthFiles()) {
    try {
      const data = await readJson(candidate);
      if (data.tokens?.access_token && data.tokens.refresh_token) {
        return candidate;
      }
    } catch {
      // Try the next conventional location.
    }
  }

  throw new Error(
    'No OpenAI Codex auth found. Run `codex login` locally or pass auth: { type: "codex", authFile }.',
  );
}

async function refreshCodexTokens(
  refreshToken: string,
): Promise<CodexTokenData> {
  const response = await fetch(CODEX_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CODEX_CLIENT_ID,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `OpenAI Codex token refresh failed (${response.status}): ${await response.text()}`,
    );
  }

  const json = (await response.json()) as {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
  };

  if (!json.access_token || !json.refresh_token) {
    throw new Error('OpenAI Codex token refresh response was missing tokens.');
  }

  return {
    id_token: json.id_token,
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    account_id: extractAccountId({ access_token: json.access_token }),
  };
}

class OpenAICodexAuth {
  private authFile?: string;
  readonly baseUrl: string;

  constructor(options: OpenAICodexAuthOptions) {
    this.authFile = options.authFile;
    this.baseUrl = (options.baseUrl ?? DEFAULT_CODEX_BASE_URL).replace(
      /\/+$/,
      '',
    );
  }

  async getHeaders(): Promise<CodexAuthHeaders> {
    const authFile = await findAuthFile(this.authFile);
    this.authFile = authFile;

    let auth = await readJson(authFile);
    let tokens = auth.tokens;
    if (!tokens?.access_token || !tokens.refresh_token) {
      throw new Error(
        `OpenAI Codex auth file at ${authFile} does not contain ChatGPT OAuth tokens.`,
      );
    }

    if (jwtExpiresSoon(tokens.access_token)) {
      auth = await withAuthFileLock(authFile, async () => {
        const latest = await readJson(authFile);
        const latestTokens = latest.tokens;
        if (!latestTokens?.access_token || !latestTokens.refresh_token) {
          throw new Error(
            `OpenAI Codex auth file at ${authFile} does not contain ChatGPT OAuth tokens.`,
          );
        }
        if (!jwtExpiresSoon(latestTokens.access_token)) return latest;

        const refreshedTokens = await refreshCodexTokens(
          latestTokens.refresh_token,
        );
        latest.tokens = refreshedTokens;
        latest.auth_mode = 'chatgpt';
        latest.last_refresh = new Date().toISOString();
        await writeJson(authFile, latest);
        return latest;
      });
      tokens = auth.tokens;
      if (!tokens?.access_token || !tokens.refresh_token) {
        throw new Error(
          `OpenAI Codex auth file at ${authFile} does not contain ChatGPT OAuth tokens after refresh.`,
        );
      }
    }

    const accountId = extractAccountId(tokens);
    if (!accountId) {
      throw new Error('OpenAI Codex auth token does not contain account id.');
    }

    return {
      authorization: `Bearer ${tokens.access_token}`,
      accountId,
      isFedrampAccount: extractFedrampFlag(tokens),
    };
  }
}

export { OpenAICodexAuth, type CodexAuthHeaders, type OpenAICodexAuthOptions };
