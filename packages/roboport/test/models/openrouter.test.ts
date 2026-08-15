import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { Message, ModelStreamEvent } from '@/core';
import { OpenRouter } from '@/models/openrouter';

const API_KEY = 'test-key';

interface Capture {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

let captured: Capture[] = [];
const realFetch = globalThis.fetch;

function sse(chunks: unknown[]): Response {
  const body = chunks
    .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
    .join('');
  return new Response(`${body}data: [DONE]\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function stubFetch(respond: (capture: Capture) => Response): void {
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      (init?.headers ?? {}) as Record<string, string>,
    )) {
      headers[key.toLowerCase()] = value;
    }
    const capture: Capture = {
      url: String(input),
      headers,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    };
    captured.push(capture);
    return respond(capture);
  }) as typeof globalThis.fetch;
}

async function drain(
  model: OpenRouter,
  messages: Message[],
): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of model.streamMessage({ messages })) {
    events.push(event);
  }
  return events;
}

function userTurn(text: string): Message[] {
  return [{ role: 'user', content: text }];
}

beforeEach((): void => {
  captured = [];
});

afterEach((): void => {
  globalThis.fetch = realFetch;
});

describe('OpenRouter', (): void => {
  test('defaults to the OpenRouter base url and sends attribution headers', async (): Promise<void> => {
    stubFetch(() =>
      sse([
        { id: 'gen-1', choices: [{ delta: { content: 'hi' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]),
    );

    const model = new OpenRouter('openai/gpt-5.6-luna', {
      apiKey: API_KEY,
      referer: 'https://example.com',
      title: 'assistant',
    });
    await drain(model, userTurn('hello'));

    const call = captured[0]!;
    expect(call.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(call.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(call.headers['http-referer']).toBe('https://example.com');
    expect(call.headers['x-title']).toBe('assistant');
    expect(call.body.model).toBe('openai/gpt-5.6-luna');
  });

  test('maps every thinking level onto reasoning.effort, and omits it when off', async (): Promise<void> => {
    stubFetch(() =>
      sse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]),
    );

    for (const level of [
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
    ] as const) {
      const model = new OpenRouter('openai/gpt-5.6-luna', {
        apiKey: API_KEY,
        thinking: level,
      });
      await drain(model, userTurn('hello'));
      expect(captured.at(-1)!.body.reasoning).toEqual({ effort: level });
    }

    const off = new OpenRouter('openai/gpt-5.6-luna', {
      apiKey: API_KEY,
      thinking: 'off',
    });
    await drain(off, userTurn('hello'));
    expect(captured.at(-1)!.body.reasoning).toBeUndefined();
  });

  test('defaults to off when no thinking level is given', async (): Promise<void> => {
    stubFetch(() =>
      sse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]),
    );
    const model = new OpenRouter('openai/gpt-5.6-luna', { apiKey: API_KEY });
    await drain(model, userTurn('hello'));
    expect(captured[0]!.body.reasoning).toBeUndefined();
  });

  test('streams the plaintext reasoning channel as thinking deltas', async (): Promise<void> => {
    stubFetch(() =>
      sse([
        { choices: [{ delta: { reasoning: 'let me ' } }] },
        { choices: [{ delta: { reasoning: 'think' } }] },
        { choices: [{ delta: { content: 'answer' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]),
    );

    const model = new OpenRouter('openai/gpt-5.6-luna', {
      apiKey: API_KEY,
      thinking: 'medium',
    });
    const events = await drain(model, userTurn('hello'));

    expect(
      events
        .filter((e) => e.type === 'thinking-delta')
        .map((e) => (e as { text: string }).text),
    ).toEqual(['let me ', 'think']);
    const end = events.find((e) => e.type === 'thinking-end') as {
      text: string;
    };
    expect(end.text).toBe('let me think');
  });

  test('merges streamed reasoning_details by index and carries them on thinking-end', async (): Promise<void> => {
    stubFetch(() =>
      sse([
        {
          choices: [
            {
              delta: {
                reasoning: 'a',
                reasoning_details: [
                  { type: 'reasoning.text', index: 0, text: 'a', format: 'x' },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                reasoning: 'b',
                reasoning_details: [{ index: 0, text: 'b' }],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                reasoning_details: [
                  { type: 'reasoning.encrypted', index: 1, data: 'blob' },
                ],
              },
            },
          ],
        },
        { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] },
      ]),
    );

    const model = new OpenRouter('openai/gpt-5.6-luna', {
      apiKey: API_KEY,
      thinking: 'medium',
    });
    const events = await drain(model, userTurn('hello'));

    const end = events.find((e) => e.type === 'thinking-end') as {
      redactedData?: string;
    };
    expect(JSON.parse(end.redactedData!)).toEqual([
      { type: 'reasoning.text', index: 0, text: 'ab', format: 'x' },
      { type: 'reasoning.encrypted', index: 1, data: 'blob' },
    ]);
  });

  test('falls back to reasoning_details text when the plaintext channel is absent', async (): Promise<void> => {
    stubFetch(() =>
      sse([
        {
          choices: [
            {
              delta: {
                reasoning_details: [{ index: 0, summary: 'summarised' }],
              },
            },
          ],
        },
        { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] },
      ]),
    );

    const model = new OpenRouter('openai/gpt-5.6-luna', {
      apiKey: API_KEY,
      thinking: 'medium',
    });
    const events = await drain(model, userTurn('hello'));
    const end = events.find((e) => e.type === 'thinking-end') as {
      text: string;
    };
    expect(end.text).toBe('summarised');
  });

  test('replays reasoning_details on the assistant message of a later turn', async (): Promise<void> => {
    stubFetch(() =>
      sse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]),
    );

    const model = new OpenRouter('openai/gpt-5.6-luna', {
      apiKey: API_KEY,
      thinking: 'medium',
    });
    await drain(model, [
      { role: 'user', content: 'what time is it' },
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            text: 'need the clock',
            redactedData: JSON.stringify([
              { type: 'reasoning.encrypted', index: 0, data: 'blob' },
            ]),
          },
          {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'bash',
            input: { command: 'date' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_1',
            toolName: 'bash',
            output: '12:00',
          },
        ],
      },
    ]);

    const messages = captured[0]!.body.messages as Record<string, unknown>[];
    const assistant = messages[1]!;
    expect(assistant.reasoning_details).toEqual([
      { type: 'reasoning.encrypted', index: 0, data: 'blob' },
    ]);
    expect(assistant.content).toBeNull();
    expect(messages[2]!.role).toBe('tool');
  });

  test('drops an unparseable reasoning blob rather than failing the turn', async (): Promise<void> => {
    stubFetch(() =>
      sse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]),
    );

    const model = new OpenRouter('openai/gpt-5.6-luna', { apiKey: API_KEY });
    await drain(model, [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', text: 'hmm', redactedData: 'not-json' },
          { type: 'text', text: 'hello' },
        ],
      },
    ]);

    const messages = captured[0]!.body.messages as Record<string, unknown>[];
    expect(messages[1]!.reasoning_details).toBeUndefined();
    expect(messages[1]!.content).toBe('hello');
  });

  test('searchWeb enables the web plugin and reads url_citation annotations', async (): Promise<void> => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: 'Two results.',
                  annotations: [
                    {
                      type: 'url_citation',
                      url_citation: {
                        url: 'https://a.example',
                        title: 'A',
                        content: 'about a',
                      },
                    },
                    {
                      type: 'url_citation',
                      url_citation: { url: 'https://a.example', title: 'dupe' },
                    },
                    {
                      type: 'url_citation',
                      url_citation: { url: 'https://b.example' },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    const model = new OpenRouter('openai/gpt-5.6-luna', { apiKey: API_KEY });
    const hits = await model.searchWeb('roboport', {
      maxUses: 5,
      allowedDomains: ['a.example'],
    });

    expect(captured[0]!.body.plugins).toEqual([
      { id: 'web', max_results: 5, include_domains: ['a.example'] },
    ]);
    expect(hits).toEqual([
      { title: 'A', url: 'https://a.example', text: 'about a' },
      { title: 'https://b.example', url: 'https://b.example' },
    ]);
  });

  test('searchWeb surfaces the prose answer when there are no citations', async (): Promise<void> => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'The answer.' } }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    const model = new OpenRouter('openai/gpt-5.6-luna', { apiKey: API_KEY });
    expect(await model.searchWeb('roboport')).toEqual([
      { title: 'Web search answer', text: 'The answer.' },
    ]);
  });

  test('throws a helpful error when no api key is configured', (): void => {
    const previous = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      expect(() => new OpenRouter('openai/gpt-5.6-luna')).toThrow(
        /OPENROUTER_API_KEY/,
      );
    } finally {
      if (previous !== undefined) process.env.OPENROUTER_API_KEY = previous;
    }
  });
});
