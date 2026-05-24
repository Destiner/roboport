import type { LiteralUnion, SearchHit, SearchOptions } from '@/core';
import { env } from '@/env';

import {
  OpenAICompatibleModel,
  type OpenAIAssistantWireMessage,
} from './openai-compatible';

const MOONSHOT_MODELS = ['kimi-k2.6', 'kimi-k2.5'] as const;

type MoonshotModelName = LiteralUnion<(typeof MOONSHOT_MODELS)[number]>;

interface MoonshotToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

interface MoonshotChatResponse {
  choices: {
    finish_reason: string;
    message: {
      role: 'assistant';
      content: string | null;
      reasoning_content?: string;
      tool_calls?: MoonshotToolCall[];
    };
  }[];
}

class MoonshotModel extends OpenAICompatibleModel {
  constructor(
    modelName: MoonshotModelName,
    options?: { apiKey?: string; baseUrl?: string },
  ) {
    const key = options?.apiKey ?? env.moonshotApiKey;
    if (!key) {
      throw new Error(
        'No Moonshot API key found. Set MOONSHOT_API_KEY or pass apiKey.',
      );
    }
    super(modelName, {
      apiKey: key,
      baseUrl: options?.baseUrl ?? 'https://api.moonshot.ai/v1',
    });
  }

  // Thinking-enabled Kimi models reject assistant tool-call messages without
  // a `reasoning_content` field. Non-thinking models accept the extra field.
  protected override adaptAssistantWire(
    msg: OpenAIAssistantWireMessage,
  ): OpenAIAssistantWireMessage {
    if (!msg.tool_calls) return msg;
    return { ...msg, reasoning_content: '' } as OpenAIAssistantWireMessage;
  }

  override async searchWeb(
    query: string,
    opts?: SearchOptions,
  ): Promise<SearchHit[]> {
    // Moonshot's $web_search builtin: the model emits a tool_call whose
    // arguments wrap a search_id. Echo the same arguments back as the tool
    // result and Moonshot's backend resolves the search server-side before
    // generating the final answer with URL citations.
    const messages: Record<string, unknown>[] = [
      {
        role: 'user',
        content: `Search the web for: ${query}. List the most relevant results with their URLs.`,
      },
    ];
    const tools = [
      {
        type: 'builtin_function',
        function: { name: '$web_search' },
      },
    ];

    let response = await this.chat(messages, tools);
    let choice = response.choices[0];

    for (let i = 0; i < 4; i++) {
      if (!choice) break;
      const toolCalls = choice.message.tool_calls;
      if (!toolCalls || toolCalls.length === 0) break;

      messages.push({
        role: 'assistant',
        content: choice.message.content ?? '',
        reasoning_content: choice.message.reasoning_content ?? '',
        tool_calls: toolCalls,
      });
      for (const call of toolCalls) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.function.name,
          content: call.function.arguments,
        });
      }

      response = await this.chat(messages, tools);
      choice = response.choices[0];
    }

    const text = choice?.message.content ?? '';
    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    const urlRegex = /https?:\/\/[^\s)\]>"']+/g;
    for (const raw of text.match(urlRegex) ?? []) {
      const url = raw.replace(/[.,;:!?]+$/, '');
      if (seen.has(url)) continue;
      seen.add(url);
      hits.push({ title: url, url });
    }

    if (opts?.maxUses !== undefined) return hits.slice(0, opts.maxUses);
    return hits;
  }

  private async chat(
    messages: unknown[],
    tools: unknown[],
  ): Promise<MoonshotChatResponse> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.modelName,
        messages,
        tools,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Moonshot web_search failed (${response.status}): ${await response.text()}`,
      );
    }

    return (await response.json()) as MoonshotChatResponse;
  }
}

export { MoonshotModel, MOONSHOT_MODELS };
