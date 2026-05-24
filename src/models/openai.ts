import type {
  CreateMessageParams,
  CreateMessageResponse,
  LiteralUnion,
  Message,
  SearchHit,
  SearchOptions,
  StopReason,
  TextPart,
  Tool,
  ToolCallPart,
} from '@/core';

import { OpenAICodexAuth } from './openai-codex-auth';
import { OpenAICompatibleModel } from './openai-compatible';

const OPENAI_MODELS = [
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
  'gpt-5.3-codex',
] as const;

type OpenAIModelName = LiteralUnion<(typeof OPENAI_MODELS)[number]>;

type OpenAIApiKeyAuthOptions = {
  type: 'apiKey';
  apiKey?: string;
};

type OpenAICodexAuthModelOptions = {
  type: 'codex';
  authFile?: string;
};

type OpenAIAuthOptions = OpenAIApiKeyAuthOptions | OpenAICodexAuthModelOptions;

type OpenAIModelOptions = {
  auth?: OpenAIAuthOptions;
  baseUrl?: string;
};

type ResponsesInputItem =
  | { role: 'user'; content: { type: 'input_text'; text: string }[] }
  | {
      type: 'message';
      role: 'assistant';
      content: { type: 'output_text'; text: string; annotations: unknown[] }[];
      status: 'completed';
      id: string;
    }
  | {
      type: 'function_call';
      call_id: string;
      name: string;
      arguments: string;
      id?: string;
    }
  | { type: 'function_call_output'; call_id: string; output: string };

type ResponsesOutputItem =
  | {
      type: 'message';
      content?: { type: string; text?: string; annotations?: unknown[] }[];
    }
  | {
      type: 'function_call';
      call_id?: string;
      id?: string;
      name: string;
      arguments?: string;
    }
  | { type: 'reasoning' | 'web_search_call' | 'computer_call' };

type ResponsesJson = {
  id: string;
  status?: string;
  output?: ResponsesOutputItem[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
};

type ResponsesStreamEvent =
  | { type: 'response.completed'; response: ResponsesJson }
  | { type: 'response.failed'; response?: { error?: { message?: string } } }
  | { type: 'response.output_item.done'; item: ResponsesOutputItem };

function serializeToolOutput(output: unknown): string {
  if (output === undefined || output === null) return '';
  if (typeof output === 'string') return output;
  return JSON.stringify(output);
}

function parseToolArguments(raw: string | undefined): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function sanitizeResponsesId(id: string): string {
  const normalized = id.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+$/, '');
  return normalized.slice(0, 64) || 'item';
}

function responsesMessageInput(messages: Message[]): {
  instructions?: string;
  input: ResponsesInputItem[];
} {
  const instructions: string[] = [];
  const input: ResponsesInputItem[] = [];
  let messageIndex = 0;

  for (const msg of messages) {
    if (msg.role === 'system') {
      instructions.push(msg.content);
      continue;
    }

    if (msg.role === 'user') {
      const text =
        typeof msg.content === 'string'
          ? msg.content
          : msg.content.map((part) => part.text).join('\n');
      input.push({ role: 'user', content: [{ type: 'input_text', text }] });
      continue;
    }

    if (msg.role === 'assistant') {
      for (const part of msg.content) {
        if (part.type === 'text') {
          input.push({
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'output_text', text: part.text, annotations: [] },
            ],
            status: 'completed',
            id: `msg_${messageIndex}`,
          });
        } else {
          input.push({
            type: 'function_call',
            id: `fc_${sanitizeResponsesId(part.toolCallId)}`,
            call_id: part.toolCallId,
            name: part.toolName,
            arguments: JSON.stringify(part.input ?? {}),
          });
        }
      }
      messageIndex++;
      continue;
    }

    for (const part of msg.content) {
      input.push({
        type: 'function_call_output',
        call_id: part.toolCallId,
        output: serializeToolOutput(part.output),
      });
    }
  }

  return {
    instructions:
      instructions.length > 0 ? instructions.join('\n\n') : undefined,
    input,
  };
}

function responsesTools(tools: Tool[] | undefined): object[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.toJsonSchema(),
  }));
}

function mapResponsesStatus(status: string | undefined): StopReason {
  switch (status) {
    case 'incomplete':
      return 'max_tokens';
    case 'failed':
    case 'cancelled':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

class OpenAIModel extends OpenAICompatibleModel {
  private codexAuth?: OpenAICodexAuth;

  constructor(modelName: OpenAIModelName, options?: OpenAIModelOptions) {
    const auth = options?.auth ?? { type: 'apiKey' };
    const key: string =
      auth.type === 'apiKey'
        ? (auth.apiKey ?? process.env.OPENAI_API_KEY ?? '')
        : '';
    if (auth.type === 'apiKey' && !key) {
      throw new Error(
        'No OpenAI API key found. Set OPENAI_API_KEY or pass auth: { type: "apiKey", apiKey }.',
      );
    }
    super(modelName, {
      apiKey: key,
      baseUrl: options?.baseUrl ?? 'https://api.openai.com/v1',
    });
    if (auth.type === 'codex') {
      this.codexAuth = new OpenAICodexAuth({
        type: 'codex',
        authFile: auth.authFile,
        baseUrl: options?.baseUrl,
      });
      this.baseUrl = this.codexAuth.baseUrl;
    }
  }

  override async createMessage(
    params: CreateMessageParams,
  ): Promise<CreateMessageResponse> {
    if (!this.codexAuth) return super.createMessage(params);
    return this.createCodexMessage(params);
  }

  override async searchWeb(
    query: string,
    opts?: SearchOptions,
  ): Promise<SearchHit[]> {
    if (this.codexAuth) {
      const json = await this.fetchCodexResponses({
        model: this.modelName,
        stream: true,
        tools: [{ type: 'web_search_preview' }],
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: `Search the web for: ${query}` },
            ],
          },
        ],
        instructions: 'You are a helpful assistant.',
      });
      const hits = extractSearchHits(json);
      if (opts?.maxUses !== undefined) return hits.slice(0, opts.maxUses);
      return hits;
    }

    const response = await fetch(`${this.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.modelName,
        tools: [{ type: 'web_search_preview' }],
        input: `Search the web for: ${query}`,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `OpenAI web_search failed (${response.status}): ${await response.text()}`,
      );
    }

    const json = (await response.json()) as {
      output: ({ type: string } & Record<string, unknown>)[];
    };

    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    for (const item of json.output) {
      if (item.type !== 'message') continue;
      const parts = item.content as
        | ({ type: string } & Record<string, unknown>)[]
        | undefined;
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        const annotations = part.annotations as
          | { type: string; url?: string; title?: string }[]
          | undefined;
        if (!Array.isArray(annotations)) continue;
        for (const ann of annotations) {
          if (ann.type !== 'url_citation') continue;
          if (!ann.url || seen.has(ann.url)) continue;
          seen.add(ann.url);
          hits.push({ title: ann.title ?? ann.url, url: ann.url });
        }
      }
    }

    if (opts?.maxUses !== undefined) return hits.slice(0, opts.maxUses);
    return hits;
  }

  private async createCodexMessage(
    params: CreateMessageParams,
  ): Promise<CreateMessageResponse> {
    if (params.maxTokens !== undefined) {
      throw new Error('OpenAI Codex auth does not support maxTokens.');
    }

    const { messages, tools } = params;
    const { instructions, input } = responsesMessageInput(messages);
    const wireTools = responsesTools(tools);
    const body: Record<string, unknown> = {
      model: this.modelName,
      input,
      store: false,
      stream: true,
    };
    body.instructions = instructions ?? 'You are a helpful assistant.';
    if (wireTools) body.tools = wireTools;

    const json = await this.fetchCodexResponses(body);
    return parseCodexResponse(json);
  }

  private async fetchCodexResponses(
    body: Record<string, unknown>,
  ): Promise<ResponsesJson> {
    if (!this.codexAuth) {
      throw new Error('OpenAI Codex auth is not configured.');
    }
    const auth = await this.codexAuth.getHeaders();
    const headers: Record<string, string> = {
      authorization: auth.authorization,
      'chatgpt-account-id': auth.accountId,
      originator: 'drone',
      'openai-beta': 'responses=experimental',
      accept: 'application/json',
      'content-type': 'application/json',
    };
    if (auth.isFedrampAccount) headers['x-openai-fedramp'] = 'true';

    const response = await fetch(`${this.codexAuth.baseUrl}/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(
        `OpenAI Codex Responses error ${response.status}: ${await response.text()}`,
      );
    }

    if (body.stream === true)
      return parseResponsesStream(await response.text());

    return (await response.json()) as ResponsesJson;
  }
}

function parseResponsesStream(raw: string): ResponsesJson {
  const output: ResponsesOutputItem[] = [];
  let completed: ResponsesJson | undefined;

  for (const event of parseSseEvents(raw)) {
    if (event.type === 'response.output_item.done') {
      output.push(event.item);
      continue;
    }
    if (event.type === 'response.completed') {
      completed = event.response;
      continue;
    }
    if (event.type === 'response.failed') {
      throw new Error(
        event.response?.error?.message ?? 'OpenAI Codex response failed.',
      );
    }
  }

  if (!completed) {
    throw new Error('OpenAI Codex stream ended before response.completed.');
  }

  return {
    ...completed,
    output:
      completed.output && completed.output.length > 0
        ? completed.output
        : output,
  };
}

function parseSseEvents(raw: string): ResponsesStreamEvent[] {
  const events: ResponsesStreamEvent[] = [];

  for (const block of raw.split(/\r?\n\r?\n/)) {
    const dataLines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart());
    if (dataLines.length === 0) continue;

    const data = dataLines.join('\n');
    if (data === '[DONE]') continue;

    try {
      events.push(JSON.parse(data) as ResponsesStreamEvent);
    } catch {
      // Ignore malformed SSE chunks; terminal validation catches incomplete streams.
    }
  }

  return events;
}

function parseCodexResponse(json: ResponsesJson): CreateMessageResponse {
  const content: (TextPart | ToolCallPart)[] = [];

  for (const item of json.output ?? []) {
    if (item.type === 'message') {
      for (const part of item.content ?? []) {
        if (part.type === 'output_text' && part.text) {
          content.push({ type: 'text', text: part.text });
        }
      }
      continue;
    }

    if (item.type === 'function_call') {
      content.push({
        type: 'tool-call',
        toolCallId: item.call_id ?? item.id ?? `call_${content.length}`,
        toolName: item.name,
        input: parseToolArguments(item.arguments),
      });
    }
  }

  return {
    id: json.id,
    content,
    stopReason: content.some((part) => part.type === 'tool-call')
      ? 'tool_use'
      : mapResponsesStatus(json.status),
    usage: {
      inputTokens: json.usage?.input_tokens ?? 0,
      outputTokens: json.usage?.output_tokens ?? 0,
    },
  };
}

function extractSearchHits(json: ResponsesJson): SearchHit[] {
  const hits: SearchHit[] = [];
  const seen = new Set<string>();

  for (const item of json.output ?? []) {
    if (item.type !== 'message') continue;
    for (const part of item.content ?? []) {
      const annotations = part.annotations as
        | { type: string; url?: string; title?: string }[]
        | undefined;
      if (!Array.isArray(annotations)) continue;
      for (const ann of annotations) {
        if (ann.type !== 'url_citation') continue;
        if (!ann.url || seen.has(ann.url)) continue;
        seen.add(ann.url);
        hits.push({ title: ann.title ?? ann.url, url: ann.url });
      }
    }
  }

  return hits;
}

export {
  OpenAIModel,
  OPENAI_MODELS,
  type OpenAIAuthOptions,
  type OpenAIModelOptions,
};
