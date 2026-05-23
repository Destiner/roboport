import { OAuthAuth } from '../auth';
import { Mcp } from '../core';
import type { OAuthStorage } from '../storage';

const TENDERLY_MCP_URL = 'https://mcp.tenderly.co/mcp';

function tenderlyMcp(opts?: {
  name?: string;
  storage?: OAuthStorage;
  redirectPort?: number;
}): Mcp {
  const auth = new OAuthAuth({
    serverUrl: TENDERLY_MCP_URL,
    storageKey: 'tenderly',
    storage: opts?.storage,
    redirectPort: opts?.redirectPort,
  });
  return new Mcp({
    name: opts?.name ?? 'tenderly',
    transport: {
      type: 'http',
      url: TENDERLY_MCP_URL,
      auth,
    },
  });
}

export default tenderlyMcp;
