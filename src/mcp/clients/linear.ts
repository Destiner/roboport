import { BearerAuth } from '../auth';
import { Mcp } from '../core';

const LINEAR_MCP_URL = 'https://mcp.linear.app/mcp';

function linearMcp(opts: { apiKey: string; name?: string }): Mcp {
  return new Mcp({
    name: opts.name ?? 'linear',
    transport: {
      type: 'http',
      url: LINEAR_MCP_URL,
      auth: new BearerAuth(opts.apiKey),
    },
  });
}

export default linearMcp;
