import type { GithubAppCredentials } from './github-app';

interface Config {
  port: number;
  webhookSecret: string;
  allowedActors: string[];
  // Empty until resolved at startup: an override, else the app's bot identity.
  gitUserName: string;
  gitUserEmail: string;
  codexAuthFile: string;
  app: GithubAppCredentials;
}

function readEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

function readOptional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function loadConfig(): Config {
  return {
    port: Number(readOptional('PORT', '3000')),
    webhookSecret: readEnv('GITHUB_WEBHOOK_SECRET'),
    allowedActors: readEnv('ROBOPORT_ALLOWED_ACTORS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    gitUserName: readOptional('ROBOPORT_GIT_USER_NAME', ''),
    gitUserEmail: readOptional('ROBOPORT_GIT_USER_EMAIL', ''),
    codexAuthFile: readOptional(
      'ROBOPORT_OPENAI_CODEX_AUTH_FILE',
      '/data/openai-codex-auth.json',
    ),
    app: {
      appId: readEnv('GITHUB_APP_ID'),
      privateKey: readEnv('GITHUB_APP_PRIVATE_KEY'),
      installationId: process.env.GITHUB_APP_INSTALLATION_ID || undefined,
    },
  };
}

export { loadConfig, type Config };
