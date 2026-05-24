import { BearerAuth } from '../auth';
import { Mcp as McpBase } from '../core';

type Options = {
  apiKey: string;
  name?: string;
};

const LINEAR_MCP_URL = 'https://mcp.linear.app/mcp';

class Mcp extends McpBase {
  constructor(opts: Options) {
    super({
      name: opts.name ?? 'linear',
      transport: {
        type: 'http',
        url: LINEAR_MCP_URL,
        auth: new BearerAuth(opts.apiKey),
      },
    });
  }
}

export default Mcp;
