import {
  captureAuthorizationCode,
  discover,
  exchangeCode,
  generatePkce,
  generateState,
  openBrowser,
  refreshTokens,
  registerClient,
  type AuthorizationServerMetadata,
  type TokenResponse,
} from './oauth';
import { FileStorage, type OAuthStorage, type TokenSet } from './storage';

interface AuthProvider {
  getHeader(): Promise<string>;
  onUnauthorized?(): Promise<void>;
}

class BearerAuth implements AuthProvider {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  async getHeader(): Promise<string> {
    return `Bearer ${this.token}`;
  }
}

type OAuthAuthOptions = {
  serverUrl: string;
  storageKey: string;
  storage?: OAuthStorage;
  redirectPort?: number;
  scopes?: string[];
  flowTimeoutMs?: number;
  // Pre-registered client id, for servers without dynamic client registration.
  clientId?: string;
};

const DEFAULT_PORT = 33418;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

class OAuthAuth implements AuthProvider {
  private serverUrl: string;
  private storage: OAuthStorage;
  private storageKey: string;
  private redirectPort: number;
  private scopes?: string[];
  private flowTimeoutMs: number;
  private clientId?: string;
  private tokens?: TokenSet;
  private loaded = false;
  private metadata?: AuthorizationServerMetadata;
  private inFlight?: Promise<void>;

  constructor(opts: OAuthAuthOptions) {
    this.serverUrl = opts.serverUrl;
    this.storage = opts.storage ?? new FileStorage();
    this.storageKey = opts.storageKey;
    this.redirectPort = opts.redirectPort ?? DEFAULT_PORT;
    this.scopes = opts.scopes;
    this.flowTimeoutMs = opts.flowTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.clientId = opts.clientId;
  }

  async getHeader(): Promise<string> {
    await this.ensureTokens();
    if (!this.tokens) throw new Error('OAuth: no tokens after auth flow.');
    return `Bearer ${this.tokens.accessToken}`;
  }

  async onUnauthorized(): Promise<void> {
    if (this.tokens?.refreshToken) {
      try {
        await this.refresh();
        return;
      } catch {
        // Fall through to full re-auth.
      }
    }
    this.tokens = undefined;
    await this.storage.clear(this.storageKey);
    await this.authorize();
  }

  private async ensureTokens(): Promise<void> {
    if (this.inFlight) {
      await this.inFlight;
      return;
    }
    this.inFlight = (async (): Promise<void> => {
      if (!this.loaded) {
        this.tokens = (await this.storage.load(this.storageKey)) ?? undefined;
        this.loaded = true;
      }
      if (!this.tokens) {
        await this.authorize();
        return;
      }
      if (this.isExpired(this.tokens)) {
        if (this.tokens.refreshToken) {
          try {
            await this.refresh();
            return;
          } catch {
            // Fall through to interactive re-auth.
          }
        }
        await this.authorize();
      }
    })();
    try {
      await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
  }

  private isExpired(tokens: TokenSet): boolean {
    if (!tokens.expiresAt) return false;
    return Date.now() / 1000 >= tokens.expiresAt - 30;
  }

  private async getMetadata(): Promise<AuthorizationServerMetadata> {
    if (!this.metadata) this.metadata = await discover(this.serverUrl);
    return this.metadata;
  }

  private async authorize(): Promise<void> {
    const meta = await this.getMetadata();
    const redirectUri =
      this.tokens?.redirectUri ??
      `http://127.0.0.1:${this.redirectPort}/callback`;
    let clientId = this.tokens?.clientId ?? this.clientId;
    if (!clientId) {
      if (!meta.registration_endpoint) {
        throw new Error(
          'OAuth server does not support dynamic client registration; pass a clientId.',
        );
      }
      clientId = await registerClient(meta.registration_endpoint, redirectUri);
    }

    const { verifier, challenge } = await generatePkce();
    const state = generateState();
    const port = parseInt(new URL(redirectUri).port, 10);

    const codePromise = captureAuthorizationCode(
      port,
      state,
      this.flowTimeoutMs,
    );

    const authUrl = new URL(meta.authorization_endpoint);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state', state);
    if (this.scopes?.length) {
      authUrl.searchParams.set('scope', this.scopes.join(' '));
    }

    console.error(
      `[mcp:oauth] Opening browser for ${this.storageKey} authentication...`,
    );
    openBrowser(authUrl.toString());
    const code = await codePromise;

    const response = await exchangeCode({
      tokenEndpoint: meta.token_endpoint,
      code,
      clientId,
      redirectUri,
      verifier,
    });
    this.tokens = this.toTokenSet(response, clientId, redirectUri);
    await this.storage.save(this.storageKey, this.tokens);
  }

  private async refresh(): Promise<void> {
    if (!this.tokens?.refreshToken || !this.tokens.clientId) {
      throw new Error('OAuth refresh: missing refresh token or client id.');
    }
    const meta = await this.getMetadata();
    const response = await refreshTokens({
      tokenEndpoint: meta.token_endpoint,
      refreshToken: this.tokens.refreshToken,
      clientId: this.tokens.clientId,
    });
    this.tokens = this.toTokenSet(
      response,
      this.tokens.clientId,
      this.tokens.redirectUri,
      this.tokens.refreshToken,
    );
    await this.storage.save(this.storageKey, this.tokens);
  }

  private toTokenSet(
    response: TokenResponse,
    clientId: string,
    redirectUri?: string,
    fallbackRefresh?: string,
  ): TokenSet {
    const expiresAt = response.expires_in
      ? Math.floor(Date.now() / 1000) + response.expires_in
      : undefined;
    return {
      accessToken: response.access_token,
      refreshToken: response.refresh_token ?? fallbackRefresh,
      expiresAt,
      clientId,
      redirectUri,
    };
  }
}

export { BearerAuth, OAuthAuth, type AuthProvider, type OAuthAuthOptions };
