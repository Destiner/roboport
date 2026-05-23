interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: number | string;
  result: unknown;
}

interface JsonRpcError {
  jsonrpc: '2.0';
  id: number | string | null;
  error: { code: number; message: string };
}

const numberPair = {
  type: 'object',
  properties: {
    a: { type: 'number', description: 'Left-hand operand.' },
    b: { type: 'number', description: 'Right-hand operand.' },
  },
  required: ['a', 'b'],
  additionalProperties: false,
} as const;

const tools = [
  { name: 'add', description: 'Add two numbers.', inputSchema: numberPair },
  {
    name: 'subtract',
    description: 'Subtract b from a.',
    inputSchema: numberPair,
  },
  {
    name: 'multiply',
    description: 'Multiply two numbers.',
    inputSchema: numberPair,
  },
  {
    name: 'divide',
    description: 'Divide a by b.',
    inputSchema: numberPair,
  },
];

function send(msg: JsonRpcSuccess | JsonRpcError): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function textResult(
  id: number | string,
  text: string,
  isError = false,
): JsonRpcSuccess {
  return {
    jsonrpc: '2.0',
    id,
    result: { content: [{ type: 'text', text }], isError },
  };
}

function calculate(name: string, a: number, b: number): number | string {
  switch (name) {
    case 'add':
      return a + b;
    case 'subtract':
      return a - b;
    case 'multiply':
      return a * b;
    case 'divide':
      if (b === 0) return 'Error: division by zero.';
      return a / b;
    default:
      return `Error: unknown tool "${name}".`;
  }
}

function handle(req: JsonRpcRequest): void {
  if (req.method === 'notifications/initialized') return;

  if (req.id === undefined) return;
  const id = req.id;

  if (req.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'calculator', version: '0.1.0' },
      },
    });
    return;
  }

  if (req.method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools } });
    return;
  }

  if (req.method === 'tools/call') {
    const params = req.params as
      | { name?: string; arguments?: { a?: number; b?: number } }
      | undefined;
    const name = params?.name;
    const args = params?.arguments;
    if (!name || typeof args?.a !== 'number' || typeof args?.b !== 'number') {
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: 'Invalid params.' },
      });
      return;
    }
    const value = calculate(name, args.a, args.b);
    const isError = typeof value === 'string';
    send(textResult(id, String(value), isError));
    return;
  }

  send({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Unknown method: ${req.method}` },
  });
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  let idx = buffer.indexOf('\n');
  while (idx !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) {
      try {
        handle(JSON.parse(line) as JsonRpcRequest);
      } catch {
        // Ignore malformed lines.
      }
    }
    idx = buffer.indexOf('\n');
  }
});
process.stdin.on('end', () => {
  process.exit(0);
});
