import {
  Model,
  type CreateMessageParams,
  type CreateMessageResponse,
  type LiteralUnion,
  type Message,
  type SearchHit,
  type SearchOptions,
  type StopReason,
  type TextPart,
  type ToolCallPart,
} from '@/core';

const ANTHROPIC_MODELS = [
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
] as const;

type AnthropicModelName = LiteralUnion<(typeof ANTHROPIC_MODELS)[number]>;

type AnthropicWireContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };

interface AnthropicWireMessage {
  role: 'user' | 'assistant';
  content: AnthropicWireContent[];
}

interface WebSearchResultBlock {
  type: 'web_search_result';
  url: string;
  title: string;
  page_age?: string | null;
  encrypted_content?: string;
}

function serializeToolOutput(output: unknown): string {
  if (output === undefined || output === null) return '';
  if (typeof output === 'string') return output;
  return JSON.stringify(output);
}

function toWire(messages: Message[]): {
  system: string | undefined;
  wireMessages: AnthropicWireMessage[];
} {
  let system: string | undefined;
  const wireMessages: AnthropicWireMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      system = msg.content;
      continue;
    }

    if (msg.role === 'user') {
      const content: AnthropicWireContent[] =
        typeof msg.content === 'string'
          ? [{ type: 'text', text: msg.content }]
          : msg.content.map((part) => ({ type: 'text', text: part.text }));
      wireMessages.push({ role: 'user', content });
      continue;
    }

    if (msg.role === 'assistant') {
      wireMessages.push({
        role: 'assistant',
        content: msg.content.map((part) =>
          part.type === 'text'
            ? { type: 'text', text: part.text }
            : {
                type: 'tool_use',
                id: part.toolCallId,
                name: part.toolName,
                input: part.input,
              },
        ),
      });
      continue;
    }

    wireMessages.push({
      role: 'user',
      content: msg.content.map((part) => ({
        type: 'tool_result',
        tool_use_id: part.toolCallId,
        content: serializeToolOutput(part.output),
      })),
    });
  }

  return { system, wireMessages };
}

class AnthropicModel extends Model {
  modelName: string;
  apiKey: string;

  constructor(modelName: AnthropicModelName, options?: { apiKey?: string }) {
    super();
    this.modelName = modelName;
    const key = options?.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error(
        'No Anthropic API key found. Set ANTHROPIC_API_KEY or pass apiKey.',
      );
    }
    this.apiKey = key;
  }

  override async createMessage(
    params: CreateMessageParams,
  ): Promise<CreateMessageResponse> {
    const { messages, tools, maxTokens = 8192 } = params;
    const { system, wireMessages } = toWire(messages);

    const wireTools = tools?.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.toJsonSchema(),
    }));

    const body: Record<string, unknown> = {
      model: this.modelName,
      max_tokens: maxTokens,
      messages: wireMessages,
    };
    if (system !== undefined) body.system = system;
    if (wireTools !== undefined && wireTools.length > 0) body.tools = wireTools;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(
        `Anthropic API error ${response.status}: ${await response.text()}`,
      );
    }

    const json = (await response.json()) as {
      id: string;
      content: AnthropicWireContent[];
      stop_reason: StopReason;
      usage: { input_tokens: number; output_tokens: number };
    };

    const content: (TextPart | ToolCallPart)[] = json.content.map((block) => {
      if (block.type === 'text') {
        return { type: 'text', text: block.text };
      }
      if (block.type === 'tool_use') {
        return {
          type: 'tool-call',
          toolCallId: block.id,
          toolName: block.name,
          input: block.input,
        };
      }
      throw new Error(`Unexpected content block from Anthropic: ${block.type}`);
    });

    return {
      id: json.id,
      content,
      stopReason: json.stop_reason,
      usage: {
        inputTokens: json.usage.input_tokens,
        outputTokens: json.usage.output_tokens,
      },
    };
  }

  override async searchWeb(
    query: string,
    opts?: SearchOptions,
  ): Promise<SearchHit[]> {
    const tool: Record<string, unknown> = {
      type: 'web_search_20250305',
      name: 'web_search',
    };
    if (opts?.allowedDomains) tool.allowed_domains = opts.allowedDomains;
    if (opts?.blockedDomains) tool.blocked_domains = opts.blockedDomains;
    if (opts?.maxUses !== undefined) tool.max_uses = opts.maxUses;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.modelName,
        max_tokens: 1024,
        tools: [tool],
        messages: [{ role: 'user', content: `Search the web for: ${query}` }],
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Anthropic web_search failed (${response.status}): ${await response.text()}`,
      );
    }

    const json = (await response.json()) as {
      content: ({ type: string } & Record<string, unknown>)[];
    };

    const hits: SearchHit[] = [];
    for (const block of json.content) {
      if (block.type !== 'web_search_tool_result') continue;
      const content = block.content as WebSearchResultBlock[] | undefined;
      if (!Array.isArray(content)) continue;
      for (const item of content) {
        if (item.type !== 'web_search_result') continue;
        hits.push({
          title: item.title,
          url: item.url,
          pageAge: item.page_age ?? undefined,
        });
      }
    }
    return hits;
  }
}

export { AnthropicModel, ANTHROPIC_MODELS };
