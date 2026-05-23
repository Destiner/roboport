import type { Message, TextPart, ToolCallPart } from '@/message';

type StopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'stop_sequence'
  | 'pause_turn'
  | 'refusal';

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: object;
}

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

interface CreateMessageParams {
  apiKey: string;
  model: string;
  messages: Message[];
  tools?: AnthropicTool[];
  maxTokens?: number;
}

interface CreateMessageResponse {
  id: string;
  content: (TextPart | ToolCallPart)[];
  stopReason: StopReason;
  usage: { inputTokens: number; outputTokens: number };
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

    // role === 'tool' — Anthropic packs tool results inside a user message
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

async function createMessage(
  params: CreateMessageParams,
): Promise<CreateMessageResponse> {
  const { apiKey, model, messages, tools, maxTokens = 8192 } = params;
  const { system, wireMessages } = toWire(messages);

  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages: wireMessages,
  };
  if (system !== undefined) body.system = system;
  if (tools !== undefined && tools.length > 0) body.tools = tools;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${errorText}`);
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

export {
  type AnthropicTool,
  type CreateMessageParams,
  type CreateMessageResponse,
  createMessage,
};
