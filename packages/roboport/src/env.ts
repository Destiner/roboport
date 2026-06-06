// Single source of truth for env vars read by roboport.
// Reads are lazy: roboport is a library, so importing it must never throw
// because of unset vars. Each model still accepts an explicit override
// and falls back to the matching getter here.

function read(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

// eslint-disable-next-line import-x/prefer-default-export
export const env = {
  get anthropicApiKey() {
    return read('ANTHROPIC_API_KEY');
  },
  get geminiApiKey() {
    return read('GEMINI_API_KEY');
  },
  get moonshotApiKey() {
    return read('MOONSHOT_API_KEY');
  },
  get openaiApiKey() {
    return read('OPENAI_API_KEY');
  },
  get openaiCodexAuthFile() {
    return read('ROBOPORT_OPENAI_CODEX_AUTH_FILE');
  },
  get codexHome() {
    return read('CODEX_HOME');
  },
} as const;
