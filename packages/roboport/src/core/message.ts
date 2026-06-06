type TextPart = { type: 'text'; text: string };

// Models that emit extended reasoning return thinking blocks alongside text and
// tool calls. Anthropic requires these to be echoed back verbatim when the
// turn that produced them used a tool, so we keep the opaque signature/redacted
// payload on the part itself. Other providers drop it when serialising.
type ThinkingPart = {
  type: 'thinking';
  text: string;
  signature?: string;
  redactedData?: string;
};

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
  | { role: 'assistant'; content: (TextPart | ThinkingPart | ToolCallPart)[] }
  | { role: 'tool'; content: ToolResultPart[] };

export type { TextPart, ThinkingPart, ToolCallPart, ToolResultPart, Message };
