import { createSign } from 'node:crypto';

// GitHub App auth: sign a short-lived JWT with the app private key, exchange it
// for an installation access token, and keep that token in process.env.GH_TOKEN.
// Callers must spawn gh/git with env: process.env so the token reaches them —
// Bun seeds child env from a startup snapshot and ignores later mutations.
// Installation tokens last ~1h and rotate; syncToken() refreshes them ahead of
// expiry.

const API = 'https://api.github.com';
const USER_AGENT = 'drone-bot';
// Refresh when fewer than this many ms remain on the cached token.
const EXPIRY_BUFFER_MS = 10 * 60 * 1000;

interface GithubAppCredentials {
  appId: string;
  privateKey: string;
  installationId?: string;
}

interface AppMetadata {
  slug: string;
  name: string;
}

interface Installation {
  id: number;
  account: { login: string } | null;
}

interface InstallationToken {
  token: string;
  expires_at: string;
}

interface GithubUser {
  id: number;
}

function base64url(input: string): string {
  return Buffer.from(input).toString('base64url');
}

// GitHub hands out a PKCS#1/PKCS#8 PEM. node:crypto signs it directly, so the
// only normalisation needed is unwrapping the two ways it survives env vars:
// \n-escaped on one line, or base64-encoded whole.
function normalizePrivateKey(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes('BEGIN')) {
    return trimmed.includes('\\n') ? trimmed.replace(/\\n/g, '\n') : trimmed;
  }
  return Buffer.from(trimmed, 'base64').toString('utf8');
}

class GithubApp {
  private readonly appId: string;
  private readonly privateKey: string;
  private readonly installationIdOverride?: string;

  private installationId?: string;
  private cached?: { token: string; expiresAtMs: number };

  #botLogin = '';
  #botName = '';
  #botEmail = '';

  constructor(credentials: GithubAppCredentials) {
    this.appId = credentials.appId;
    this.privateKey = normalizePrivateKey(credentials.privateKey);
    this.installationIdOverride = credentials.installationId;
  }

  get botLogin(): string {
    return this.#botLogin;
  }

  get botName(): string {
    return this.#botName;
  }

  get botEmail(): string {
    return this.#botEmail;
  }

  // Resolve the installation and bot identity, then mint the first token and
  // publish it to process.env.GH_TOKEN. Call once before serving.
  async init(): Promise<void> {
    const jwt = this.mintJwt();

    const app = await this.fetch<AppMetadata>('/app', jwt);
    this.#botLogin = `${app.slug}[bot]`;
    this.#botName = app.name || this.#botLogin;

    this.installationId =
      this.installationIdOverride ?? (await this.discoverInstallation(jwt));

    await this.syncToken();

    // Commits link to the app's bot account only when the author email is its
    // noreply address: <bot user id>+<login>@users.noreply.github.com.
    const botUser = await this.fetch<GithubUser>(
      `/users/${this.#botLogin}`,
      this.cached!.token,
    );
    this.#botEmail = `${botUser.id}+${this.#botLogin}@users.noreply.github.com`;
  }

  // Return a valid installation token, minting a fresh one if the cached token
  // is missing or near expiry. Updates process.env.GH_TOKEN as a side effect.
  async syncToken(): Promise<string> {
    if (
      this.cached &&
      this.cached.expiresAtMs - Date.now() > EXPIRY_BUFFER_MS
    ) {
      return this.cached.token;
    }
    if (!this.installationId) {
      throw new Error(
        'GithubApp.syncToken called before init resolved the installation',
      );
    }
    const jwt = this.mintJwt();
    const minted = await this.fetch<InstallationToken>(
      `/app/installations/${this.installationId}/access_tokens`,
      jwt,
      { method: 'POST' },
    );
    this.cached = {
      token: minted.token,
      expiresAtMs: Date.parse(minted.expires_at),
    };
    process.env.GH_TOKEN = minted.token;
    return minted.token;
  }

  private async discoverInstallation(jwt: string): Promise<string> {
    const installations = await this.fetch<Installation[]>(
      '/app/installations',
      jwt,
    );
    if (installations.length === 1) {
      return String(installations[0]!.id);
    }
    if (installations.length === 0) {
      throw new Error(
        'GitHub App has no installations. Install it on the target account/repos first.',
      );
    }
    const accounts = installations
      .map((i) => `${i.account?.login ?? '?'} (id ${i.id})`)
      .join(', ');
    throw new Error(
      `GitHub App has ${installations.length} installations (${accounts}). ` +
        'Set GITHUB_APP_INSTALLATION_ID to pick one.',
    );
  }

  private mintJwt(): string {
    const nowSec = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64url(
      JSON.stringify({ iat: nowSec - 60, exp: nowSec + 600, iss: this.appId }),
    );
    const data = `${header}.${payload}`;
    const signer = createSign('RSA-SHA256');
    signer.update(data);
    signer.end();
    const signature = signer.sign(this.privateKey, 'base64url');
    return `${data}.${signature}`;
  }

  private async fetch<T>(
    path: string,
    token: string,
    init?: { method?: string },
  ): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': USER_AGENT,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `GitHub ${init?.method ?? 'GET'} ${path} -> ${res.status}: ${body}`,
      );
    }
    return (await res.json()) as T;
  }
}

export { GithubApp, type GithubAppCredentials };
