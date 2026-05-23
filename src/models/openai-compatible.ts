import {
  Model,
  type CreateMessageParams,
  type CreateMessageResponse,
  type StopReason,
} from '@/core';
import type { Message, TextPart, ToolCallPart } from '@/message';

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAIAssistantWireMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: OpenAIToolCall[];
}

type OpenAIWireMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | OpenAIAssistantWireMessage
  | { role: 'tool'; tool_call_id: string; content: string };

function serializeToolOutput(output: unknown): string {
  if (output === undefined || output === null) return '';
  if (typeof output === 'string') return output;
  return JSON.stringify(output);
}

function mapFinishReason(reason: string): StopReason {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

function parseToolArguments(raw: string): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

abstract class OpenAICompatibleModel extends Model {
  modelName: string;
  apiKey: string;
  baseUrl: string;

  protected constructor(
    modelName: string,
    options: { apiKey: string; baseUrl: string },
  ) {
    super();
    this.modelName = modelName;
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
  }

  override async createMessage(
    params: CreateMessageParams,
  ): Promise<CreateMessageResponse> {
    const { messages, tools, maxTokens = 8192 } = params;
    const wireMessages = this.serializeMessages(messages);

    const wireTools = tools?.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.toJsonSchema(),
      },
    }));

    const body: Record<string, unknown> = {
      model: this.modelName,
      messages: wireMessages,
      max_completion_tokens: maxTokens,
    };
    if (wireTools !== undefined && wireTools.length > 0) body.tools = wireTools;

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(
        `Chat completions error ${response.status}: ${await response.text()}`,
      );
    }

    const json = (await response.json()) as {
      id: string;
      choices: {
        finish_reason: string;
        message: {
          content: string | null;
          tool_calls?: OpenAIToolCall[];
        };
      }[];
      usage: { prompt_tokens: number; completion_tokens: number };
    };

    const choice = json.choices[0];
    if (!choice) throw new Error('Provider returned no choices');

    const content: (TextPart | ToolCallPart)[] = [];
    if (choice.message.content) {
      content.push({ type: 'text', text: choice.message.content });
    }
    if (choice.message.tool_calls) {
      for (const call of choice.message.tool_calls) {
        content.push({
          type: 'tool-call',
          toolCallId: call.id,
          toolName: call.function.name,
          input: parseToolArguments(call.function.arguments),
        });
      }
    }

    return {
      id: json.id,
      content,
      stopReason: mapFinishReason(choice.finish_reason),
      usage: {
        inputTokens: json.usage.prompt_tokens,
        outputTokens: json.usage.completion_tokens,
      },
    };
  }

  protected serializeMessages(messages: Message[]): OpenAIWireMessage[] {
    const wire: OpenAIWireMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        wire.push({ role: 'system', content: msg.content });
        continue;
      }

      if (msg.role === 'user') {
        const content =
          typeof msg.content === 'string'
            ? msg.content
            : msg.content.map((part) => part.text).join('\n');
        wire.push({ role: 'user', content });
        continue;
      }

      if (msg.role === 'assistant') {
        const texts: string[] = [];
        const toolCalls: OpenAIToolCall[] = [];

        for (const part of msg.content) {
          if (part.type === 'text') {
            texts.push(part.text);
          } else {
            toolCalls.push({
              id: part.toolCallId,
              type: 'function',
              function: {
                name: part.toolName,
                arguments: JSON.stringify(part.input ?? {}),
              },
            });
          }
        }

        const assistantMsg: OpenAIAssistantWireMessage = {
          role: 'assistant',
          content: texts.length > 0 ? texts.join('\n') : null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        };
        wire.push(this.adaptAssistantWire(assistantMsg));
        continue;
      }

      for (const part of msg.content) {
        wire.push({
          role: 'tool',
          tool_call_id: part.toolCallId,
          content: serializeToolOutput(part.output),
        });
      }
    }

    return wire;
  }

  protected adaptAssistantWire(
    msg: OpenAIAssistantWireMessage,
  ): OpenAIAssistantWireMessage {
    return msg;
  }
}

export { OpenAICompatibleModel, type OpenAIAssistantWireMessage };
