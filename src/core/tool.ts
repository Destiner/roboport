import { z } from 'zod';

import type { Message, TextPart, ToolCallPart } from './message';

type MaybePromise<T> = T | Promise<T>;

type StopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'stop_sequence'
  | 'pause_turn'
  | 'refusal';

interface SessionState {
  messages: Message[];
  store: Map<string, unknown>;
}

interface Session {
  messages: Message[];
}

interface ToolRegistry {
  loaded(): Tool[];
  deferred(): Tool[];
  load(names: string[]): { loaded: Tool[]; missing: string[] };
}

interface SearchHit {
  title: string;
  url: string;
  pageAge?: string;
}

interface SearchOptions {
  allowedDomains?: string[];
  blockedDomains?: string[];
  maxUses?: number;
}

interface CreateMessageParams {
  messages: Message[];
  tools?: Tool[];
  maxTokens?: number;
}

interface CreateMessageResponse {
  id: string;
  content: (TextPart | ToolCallPart)[];
  stopReason: StopReason;
  usage: { inputTokens: number; outputTokens: number };
}

interface ToolContext {
  complete(prompt: string): Promise<string>;
  searchWeb(query: string, opts?: SearchOptions): Promise<SearchHit[]>;
  session: SessionState;
  tools: ToolRegistry;
}

type ZodToolInit<TSchema extends z.ZodTypeAny, TResult> = {
  name: string;
  description: string;
  inputSchema: TSchema;
  execute: (input: z.infer<TSchema>, ctx: ToolContext) => MaybePromise<TResult>;
  deferred?: boolean;
};

type RawToolInit<TResult> = {
  name: string;
  description: string;
  jsonSchema: object;
  execute: (input: unknown, ctx: ToolContext) => MaybePromise<TResult>;
  deferred?: boolean;
};

type ToolInit<TSchema extends z.ZodTypeAny, TResult> =
  | ZodToolInit<TSchema, TResult>
  | RawToolInit<TResult>;

class Tool<TSchema extends z.ZodTypeAny = z.ZodTypeAny, TResult = unknown> {
  name: string;
  description: string;
  inputSchema?: TSchema;
  jsonSchema?: object;
  execute: (input: unknown, ctx: ToolContext) => MaybePromise<TResult>;
  deferred: boolean;

  constructor(init: ZodToolInit<TSchema, TResult>);
  constructor(init: RawToolInit<TResult>);
  constructor(init: ToolInit<TSchema, TResult>) {
    this.name = init.name;
    this.description = init.description;
    this.deferred = init.deferred ?? false;
    if ('inputSchema' in init) {
      this.inputSchema = init.inputSchema;
      this.execute = init.execute as (
        input: unknown,
        ctx: ToolContext,
      ) => MaybePromise<TResult>;
    } else {
      this.jsonSchema = init.jsonSchema;
      this.execute = init.execute;
    }
  }

  toJsonSchema(): object {
    if (this.jsonSchema !== undefined) return this.jsonSchema;
    if (this.inputSchema === undefined) {
      throw new Error(
        `Tool "${this.name}" has neither inputSchema nor jsonSchema.`,
      );
    }
    return z.toJSONSchema(this.inputSchema) as object;
  }

  parse(input: unknown): unknown {
    if (this.inputSchema) return this.inputSchema.parse(input);
    return input;
  }
}

function createRegistry(tools: Tool[]): ToolRegistry {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const loadedNames = new Set<string>(
    tools.filter((tool) => !tool.deferred).map((tool) => tool.name),
  );

  return {
    loaded: () => tools.filter((tool) => loadedNames.has(tool.name)),
    deferred: () =>
      tools.filter((tool) => tool.deferred && !loadedNames.has(tool.name)),
    load: (names: string[]): { loaded: Tool[]; missing: string[] } => {
      const loaded: Tool[] = [];
      const missing: string[] = [];
      for (const name of names) {
        const tool = byName.get(name);
        if (!tool) {
          missing.push(name);
          continue;
        }
        loadedNames.add(name);
        loaded.push(tool);
      }
      return { loaded, missing };
    },
  };
}

export {
  Tool,
  createRegistry,
  type CreateMessageParams,
  type CreateMessageResponse,
  type SearchHit,
  type SearchOptions,
  type Session,
  type SessionState,
  type StopReason,
  type ToolContext,
  type ToolRegistry,
};
