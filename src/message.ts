type TextPart = { type: 'text'; text: string };

type ToolCallPart = {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  input: unknown;
};

type ToolResultPart = {
  type: 'tool-result';
  toolCallId: string;
  toolName: string;
  output: unknown;
};

type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | TextPart[] }
  | { role: 'assistant'; content: (TextPart | ToolCallPart)[] }
  | { role: 'tool'; content: ToolResultPart[] };

export type { TextPart, ToolCallPart, ToolResultPart, Message };
