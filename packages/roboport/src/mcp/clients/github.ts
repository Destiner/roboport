import { BearerAuth } from '../auth';
import { Mcp as McpBase } from '../core';

type Options = {
  token: string;
  name?: string;
  // Limit the surfaced tools to specific toolsets (e.g. ['repos', 'issues']).
  toolsets?: string[];
  // Expose only read-only tools.
  readOnly?: boolean;
  deferred?: boolean;
};

const GITHUB_MCP_URL = 'https://api.githubcopilot.com/mcp/';

class Mcp extends McpBase {
  constructor(opts: Options) {
    const headers: Record<string, string> = {};
    if (opts.toolsets?.length) {
      headers['X-MCP-Toolsets'] = opts.toolsets.join(',');
    }
    if (opts.readOnly) {
      headers['X-MCP-Readonly'] = 'true';
    }
    super({
      name: opts.name ?? 'github',
      deferred: opts.deferred,
      transport: {
        type: 'http',
        url: GITHUB_MCP_URL,
        headers,
        auth: new BearerAuth(opts.token),
      },
    });
  }
}

export default Mcp;
