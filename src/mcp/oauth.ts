interface AuthorizationServerMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
}

interface ProtectedResourceMetadata {
  authorization_servers?: string[];
}

interface RegistrationResponse {
  client_id: string;
  client_secret?: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let str = '';
  for (const byte of bytes) str += String.fromCharCode(byte);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

async function sha256(input: string): Promise<Uint8Array> {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(input),
  );
  return new Uint8Array(hash);
}

async function generatePkce(): Promise<{
  verifier: string;
  challenge: string;
}> {
  const verifier = base64UrlEncode(randomBytes(32));
  const challenge = base64UrlEncode(await sha256(verifier));
  return { verifier, challenge };
}

function generateState(): string {
  return base64UrlEncode(randomBytes(16));
}

async function discover(
  serverUrl: string,
): Promise<AuthorizationServerMetadata> {
  const u = new URL(serverUrl);
  const origin = `${u.protocol}//${u.host}`;
  let authServer = origin;
  try {
    const res = await fetch(`${origin}/.well-known/oauth-protected-resource`);
    if (res.ok) {
      const meta = (await res.json()) as ProtectedResourceMetadata;
      if (meta.authorization_servers?.[0])
        authServer = meta.authorization_servers[0];
    }
  } catch {
    // Fall through to same-origin discovery.
  }
  const asUrl = new URL(authServer);
  const asOrigin = `${asUrl.protocol}//${asUrl.host}`;
  const res = await fetch(`${asOrigin}/.well-known/oauth-authorization-server`);
  if (!res.ok) {
    throw new Error(
      `OAuth discovery failed for ${asOrigin}: ${res.status} ${await res.text()}`,
    );
  }
  return (await res.json()) as AuthorizationServerMetadata;
}

async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
): Promise<string> {
  const res = await fetch(registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'drone',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  if (!res.ok) {
    throw new Error(
      `OAuth client registration failed: ${res.status} ${await res.text()}`,
    );
  }
  const data = (await res.json()) as RegistrationResponse;
  return data.client_id;
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'start'
        : 'xdg-open';
  Bun.spawn([cmd, url], { stdout: 'ignore', stderr: 'ignore' });
}

function captureAuthorizationCode(
  port: number,
  expectedState: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const server = Bun.serve({
      port,
      hostname: '127.0.0.1',
      fetch(req): Response {
        const u = new URL(req.url);
        const error = u.searchParams.get('error');
        if (error) {
          const desc = u.searchParams.get('error_description') ?? '';
          finish(() => reject(new Error(`OAuth error: ${error} ${desc}`)));
          return new Response(
            'Authentication failed. You can close this tab.',
            {
              status: 400,
            },
          );
        }
        const code = u.searchParams.get('code');
        const state = u.searchParams.get('state');
        if (!code || state !== expectedState) {
          finish(() =>
            reject(new Error('OAuth state mismatch or missing code.')),
          );
          return new Response('Invalid OAuth response.', { status: 400 });
        }
        finish(() => resolve(code));
        return new Response(
          '<html><body>Authenticated. You can close this tab.</body></html>',
          { headers: { 'content-type': 'text/html' } },
        );
      },
    });
    const timer = setTimeout(() => {
      finish(() => reject(new Error('OAuth flow timed out.')));
    }, timeoutMs);
    function finish(action: () => void): void {
      clearTimeout(timer);
      setTimeout(() => server.stop(true), 50);
      action();
    }
  });
}

async function exchangeCode(opts: {
  tokenEndpoint: string;
  code: string;
  clientId: string;
  redirectUri: string;
  verifier: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    code_verifier: opts.verifier,
  });
  const res = await fetch(opts.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    throw new Error(
      `OAuth token exchange failed: ${res.status} ${await res.text()}`,
    );
  }
  return (await res.json()) as TokenResponse;
}

async function refreshTokens(opts: {
  tokenEndpoint: string;
  refreshToken: string;
  clientId: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: opts.refreshToken,
    client_id: opts.clientId,
  });
  const res = await fetch(opts.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    throw new Error(`OAuth refresh failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as TokenResponse;
}

export {
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
};
