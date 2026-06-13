import type {
  CreateMessageParams,
  LiteralUnion,
  Message,
  ModelStreamEvent,
  SearchHit,
  SearchOptions,
  StopReason,
  ThinkingLevel,
  Tool,
} from '@/core';
import { readSse } from '@/core/stream';
import { env } from '@/env';

import { OpenAICodexAuth } from './openai-codex-auth';
import { OpenAICompatible } from './openai-compatible';

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
  thinking?: ThinkingLevel;
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
  | { type: 'response.created'; response: { id?: string } }
  | { type: 'response.completed'; response: ResponsesJson }
  | { type: 'response.failed'; response?: { error?: { message?: string } } }
  | {
      type: 'response.output_item.added';
      item:
        | {
            type: 'message';
            id?: string;
          }
        | {
            type: 'function_call';
            id?: string;
            call_id?: string;
            name?: string;
          }
        | { type: 'reasoning'; id?: string };
      output_index?: number;
    }
  | { type: 'response.output_item.done'; item: ResponsesOutputItem }
  | { type: 'response.output_text.delta'; delta: string; output_index?: number }
  | { type: 'response.output_text.done'; text: string; output_index?: number }
  | {
      type: 'response.function_call_arguments.delta';
      delta: string;
      item_id?: string;
    }
  | {
      type: 'response.function_call_arguments.done';
      arguments: string;
      item_id?: string;
    }
  | {
      type: 'response.reasoning_summary_text.delta';
      delta: string;
    }
  | {
      type: 'response.reasoning_summary_text.done';
      text: string;
    };

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
        } else if (part.type === 'tool-call') {
          input.push({
            type: 'function_call',
            id: `fc_${sanitizeResponsesId(part.toolCallId)}`,
            call_id: part.toolCallId,
            name: part.toolName,
            arguments: JSON.stringify(part.input ?? {}),
          });
        }
        // Thinking parts originate from Anthropic and have no Responses-API
        // round-trip representation; drop them.
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

class OpenAI extends OpenAICompatible {
  private codexAuth?: OpenAICodexAuth;

  constructor(modelName: OpenAIModelName, options?: OpenAIModelOptions) {
    const auth = options?.auth ?? { type: 'apiKey' };
    const key: string =
      auth.type === 'apiKey' ? (auth.apiKey ?? env.openaiApiKey ?? '') : '';
    if (auth.type === 'apiKey' && !key) {
      throw new Error(
        'No OpenAI API key found. Set OPENAI_API_KEY or pass auth: { type: "apiKey", apiKey }.',
      );
    }
    super(modelName, {
      apiKey: key,
      baseUrl: options?.baseUrl ?? 'https://api.openai.com/v1',
      thinking: options?.thinking,
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

  override async *streamMessage(
    params: CreateMessageParams,
  ): AsyncIterable<ModelStreamEvent> {
    if (this.codexAuth || isResponsesOnlyModel(this.modelName)) {
      yield* this.streamResponses(params);
      return;
    }
    yield* super.streamMessage(params);
  }

  protected override applyThinking(body: Record<string, unknown>): void {
    if (this.thinking === 'off') return;
    // Chat Completions caps `reasoning_effort` at `high` — `xhigh` is
    // Responses-only on Codex models. Clamp instead of passing through so
    // GPT-5 (non-Codex) requests don't error.
    body.reasoning_effort = this.thinking === 'xhigh' ? 'high' : this.thinking;
  }

  override async searchWeb(
    query: string,
    opts?: SearchOptions,
  ): Promise<SearchHit[]> {
    if (this.codexAuth) {
      const json = await this.fetchResponsesBuffered({
        model: this.modelName,
        stream: true,
        // The codex backend rejects stored responses ("Store must be set to
        // false"), matching the streaming turn path above.
        store: false,
        tools: [{ type: 'web_search' }],
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
      if (hits.length > 0) {
        return opts?.maxUses !== undefined ? hits.slice(0, opts.maxUses) : hits;
      }
      // The codex web_search backend usually returns a synthesized answer with
      // no citation annotations, so extractSearchHits comes up empty. Surface
      // that answer text (in the non-url `text` field) rather than dropping it.
      const answer = extractAnswerText(json);
      if (!answer) return [];
      const result: SearchHit[] = [
        { title: 'Web search answer', text: answer },
      ];
      return opts?.maxUses !== undefined
        ? result.slice(0, opts.maxUses)
        : result;
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

  private async *streamResponses(
    params: CreateMessageParams,
  ): AsyncIterable<ModelStreamEvent> {
    if (this.codexAuth && params.maxTokens !== undefined) {
      throw new Error('OpenAI Codex auth does not support maxTokens.');
    }

    const { messages, tools, maxTokens, signal } = params;
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
    if (!this.codexAuth && maxTokens !== undefined) {
      body.max_output_tokens = maxTokens;
    }
    if (this.thinking !== 'off') {
      body.reasoning = { effort: this.thinking };
    }

    const { url, headers } = await this.responsesEndpoint();
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...headers, accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      throw new Error(
        `OpenAI Responses error ${response.status}: ${await response.text()}`,
      );
    }

    let id = '';
    let stopReason: StopReason = 'end_turn';
    let inputTokens = 0;
    let outputTokens = 0;
    let sawToolCall = false;
    let sawCompleted = false;
    let textOpen = false;
    let thinkingOpen = false;

    const toolByItemId = new Map<
      string,
      { callId: string; name: string; argsBuffer: string }
    >();
    const itemOrder: string[] = [];

    for await (const raw of readSse(response)) {
      const event = raw as ResponsesStreamEvent;

      if (event.type === 'response.created') {
        if (event.response.id) id = event.response.id;
        continue;
      }

      if (event.type === 'response.output_item.added') {
        const item = event.item;
        if (item.type === 'function_call' && item.id) {
          toolByItemId.set(item.id, {
            callId: item.call_id ?? item.id,
            name: item.name ?? '',
            argsBuffer: '',
          });
          itemOrder.push(item.id);
        }
        continue;
      }

      if (event.type === 'response.output_text.delta') {
        if (!textOpen) textOpen = true;
        yield { type: 'text-delta', text: event.delta };
        continue;
      }

      if (event.type === 'response.output_text.done') {
        if (textOpen) {
          yield { type: 'text-end', text: event.text };
          textOpen = false;
        }
        continue;
      }

      if (event.type === 'response.reasoning_summary_text.delta') {
        if (!thinkingOpen) thinkingOpen = true;
        yield { type: 'thinking-delta', text: event.delta };
        continue;
      }

      if (event.type === 'response.reasoning_summary_text.done') {
        if (thinkingOpen) {
          yield { type: 'thinking-end', text: event.text };
          thinkingOpen = false;
        }
        continue;
      }

      if (event.type === 'response.function_call_arguments.delta') {
        if (event.item_id) {
          const builder = toolByItemId.get(event.item_id);
          if (builder) builder.argsBuffer += event.delta;
        }
        continue;
      }

      if (event.type === 'response.function_call_arguments.done') {
        if (event.item_id) {
          const builder = toolByItemId.get(event.item_id);
          if (builder) builder.argsBuffer = event.arguments;
        }
        continue;
      }

      if (event.type === 'response.output_item.done') {
        const item = event.item;
        if (item.type === 'function_call') {
          sawToolCall = true;
          // Prefer the stream-accumulated args; fall back to the item's value.
          const callId = item.call_id ?? '';
          const matched = [...toolByItemId.values()].find(
            (b) => b.callId === callId,
          );
          const args = matched?.argsBuffer ?? item.arguments ?? '';
          yield {
            type: 'tool-call',
            toolCallId: callId,
            toolName: item.name,
            input: parseToolArguments(args),
          };
        }
        continue;
      }

      if (event.type === 'response.completed') {
        sawCompleted = true;
        if (!id && event.response.id) id = event.response.id;
        stopReason = sawToolCall
          ? 'tool_use'
          : mapResponsesStatus(event.response.status);
        inputTokens = event.response.usage?.input_tokens ?? inputTokens;
        outputTokens = event.response.usage?.output_tokens ?? outputTokens;
        continue;
      }

      if (event.type === 'response.failed') {
        throw new Error(
          event.response?.error?.message ?? 'OpenAI Responses stream failed.',
        );
      }
    }

    if (!sawCompleted) {
      throw new Error(
        'OpenAI Responses stream ended before response.completed; response is truncated.',
      );
    }

    yield {
      type: 'message-end',
      id,
      stopReason,
      usage: { inputTokens, outputTokens },
    };
  }

  private async fetchResponsesBuffered(
    body: Record<string, unknown>,
  ): Promise<ResponsesJson> {
    const { url, headers } = await this.responsesEndpoint();

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(
        `OpenAI Responses error ${response.status}: ${await response.text()}`,
      );
    }

    if (body.stream === true)
      return parseResponsesStream(await response.text());

    return (await response.json()) as ResponsesJson;
  }

  private async responsesEndpoint(): Promise<{
    url: string;
    headers: Record<string, string>;
  }> {
    if (this.codexAuth) {
      const auth = await this.codexAuth.getHeaders();
      const headers: Record<string, string> = {
        authorization: auth.authorization,
        'chatgpt-account-id': auth.accountId,
        originator: 'roboport',
        'openai-beta': 'responses=experimental',
        accept: 'application/json',
        'content-type': 'application/json',
      };
      if (auth.isFedrampAccount) headers['x-openai-fedramp'] = 'true';
      return { url: `${this.codexAuth.baseUrl}/responses`, headers };
    }

    return {
      url: `${this.baseUrl}/responses`,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        accept: 'application/json',
        'content-type': 'application/json',
      },
    };
  }
}

function isResponsesOnlyModel(modelName: string): boolean {
  return modelName.includes('codex');
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

function extractAnswerText(json: ResponsesJson): string {
  const parts: string[] = [];
  for (const item of json.output ?? []) {
    if (item.type !== 'message') continue;
    for (const part of item.content ?? []) {
      if (typeof part.text === 'string') parts.push(part.text);
    }
  }
  return parts.join('').trim();
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
  OpenAI,
  OPENAI_MODELS,
  type OpenAIAuthOptions,
  type OpenAIModelOptions,
};
