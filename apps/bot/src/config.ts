interface Config {
  port: number;
  webhookSecret: string;
  allowedActors: string[];
  gitUserName: string;
  gitUserEmail: string;
  codexAuthFile: string;
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
  readEnv('GH_TOKEN');
  return {
    port: Number(readOptional('PORT', '3000')),
    webhookSecret: readEnv('GITHUB_WEBHOOK_SECRET'),
    allowedActors: readEnv('DRONE_ALLOWED_ACTORS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    gitUserName: readEnv('DRONE_GIT_USER_NAME'),
    gitUserEmail: readEnv('DRONE_GIT_USER_EMAIL'),
    codexAuthFile: readOptional(
      'DRONE_OPENAI_CODEX_AUTH_FILE',
      '/data/openai-codex-auth.json',
    ),
  };
}

export { loadConfig, type Config };
