import { OAuthAuth } from '../auth';
import { Mcp as McpBase } from '../core';
import type { OAuthStorage } from '../storage';

type Options = {
  name?: string;
  storage?: OAuthStorage;
  redirectPort?: number;
};

const TENDERLY_MCP_URL = 'https://mcp.tenderly.co/mcp';

class Mcp extends McpBase {
  constructor(opts?: Options) {
    const auth = new OAuthAuth({
      serverUrl: TENDERLY_MCP_URL,
      storageKey: 'tenderly',
      storage: opts?.storage,
      redirectPort: opts?.redirectPort,
    });
    super({
      name: opts?.name ?? 'tenderly',
      transport: {
        type: 'http',
        url: TENDERLY_MCP_URL,
        auth,
      },
    });
  }
}

export default Mcp;
