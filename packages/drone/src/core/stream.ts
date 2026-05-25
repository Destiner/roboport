import type { TextPart, ThinkingPart, ToolCallPart } from './message';
import type { StopReason } from './tool';

// Provider-agnostic stream events emitted by Model.streamMessage.
// Each adapter maps its wire protocol onto this union. Consumers see token-level
// deltas for text/thinking and a single completed event per tool call.
type ModelStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'text-end'; text: string }
  | { type: 'thinking-delta'; text: string }
  | {
      type: 'thinking-end';
      text: string;
      signature?: string;
      redactedData?: string;
    }
  | {
      type: 'tool-call';
      toolCallId: string;
      toolName: string;
      input: unknown;
    }
  | {
      type: 'message-end';
      id: string;
      stopReason: StopReason;
      usage: { inputTokens: number; outputTokens: number };
    };

type AssistantContentPart = TextPart | ThinkingPart | ToolCallPart;

// Reads an SSE stream from a fetch Response, yielding each parsed `data:` JSON
// payload. Skips heartbeat lines and `[DONE]` sentinels. Throws on malformed
// JSON or a truncated trailing event so adapters can surface stream corruption
// rather than emit a silent partial turn.
async function* readSse(response: Response): AsyncGenerator<unknown> {
  if (!response.body) {
    throw new Error('Response body is empty; cannot stream.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  function* drain(): Generator<unknown> {
    let sepIdx = findEventBoundary(buffer);
    while (sepIdx !== -1) {
      const rawEvent = buffer.slice(0, sepIdx.start);
      buffer = buffer.slice(sepIdx.end);

      const payload = extractDataPayload(rawEvent);
      if (payload !== undefined) {
        yield parsePayload(payload);
      }

      sepIdx = findEventBoundary(buffer);
    }
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      yield* drain();
    }

    buffer += decoder.decode();
    yield* drain();

    if (buffer.trim().length > 0) {
      const payload = extractDataPayload(buffer);
      if (payload !== undefined) {
        yield parsePayload(payload);
      } else {
        throw new Error(
          `SSE stream ended with unterminated buffer: ${buffer.slice(0, 200)}`,
        );
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parsePayload(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch (error) {
    throw new Error(
      `Malformed SSE event payload: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function findEventBoundary(
  buffer: string,
): { start: number; end: number } | -1 {
  const candidates = ['\r\n\r\n', '\n\n', '\r\r'];
  let best = -1;
  let bestLen = 0;
  for (const sep of candidates) {
    const idx = buffer.indexOf(sep);
    if (idx === -1) continue;
    if (best === -1 || idx < best) {
      best = idx;
      bestLen = sep.length;
    }
  }
  if (best === -1) return -1;
  return { start: best, end: best + bestLen };
}

function extractDataPayload(rawEvent: string): string | undefined {
  const lines = rawEvent.split(/\r?\n/);
  const dataLines: string[] = [];
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    dataLines.push(line.slice('data:'.length).replace(/^ /, ''));
  }
  if (dataLines.length === 0) return undefined;
  const joined = dataLines.join('\n');
  if (joined === '[DONE]') return undefined;
  return joined;
}

export { readSse, type AssistantContentPart, type ModelStreamEvent };
