import * as z4 from 'zod/v4/core';

import type { Message, TextPart, ThinkingPart, ToolCallPart } from './message';

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

interface ToolRegistry {
  loaded(): Tool[];
  deferred(): Tool[];
  load(names: string[]): { loaded: Tool[]; missing: string[] };
}

interface SearchHit {
  title: string;
  url?: string;
  pageAge?: string;
  // Some backends synthesize an answer rather than a list of links (e.g. the
  // codex web_search); that text lands here and the hit carries no url.
  text?: string;
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
  signal?: AbortSignal;
}

interface CreateMessageResponse {
  id: string;
  content: (TextPart | ThinkingPart | ToolCallPart)[];
  stopReason: StopReason;
  usage: { inputTokens: number; outputTokens: number };
}

interface ToolContext {
  complete(prompt: string): Promise<string>;
  searchWeb(query: string, opts?: SearchOptions): Promise<SearchHit[]>;
  session: SessionState;
  tools: ToolRegistry;
  // Workspace directory the agent is scoped to. Built-in shell and search
  // tools use this as their default working directory; user tools may consult
  // it to resolve workspace-relative paths. Falls back to `process.cwd()`.
  cwd: string;
}

// Schemas are consumed through `zod/v4/core` rather than the full `zod`
// entrypoint so the framework stays decoupled from the builder API: any Zod 4
// schema (Classic or Mini) the consumer brings via their own zod peer satisfies
// `$ZodType`.
type ZodToolInit<TSchema extends z4.$ZodType, TResult> = {
  name: string;
  description: string;
  inputSchema: TSchema;
  execute: (
    input: z4.output<TSchema>,
    ctx: ToolContext,
  ) => MaybePromise<TResult>;
  deferred?: boolean;
};

type RawToolInit<TResult> = {
  name: string;
  description: string;
  jsonSchema: object;
  execute: (input: unknown, ctx: ToolContext) => MaybePromise<TResult>;
  deferred?: boolean;
};

type ToolInit<TSchema extends z4.$ZodType, TResult> =
  | ZodToolInit<TSchema, TResult>
  | RawToolInit<TResult>;

// Classic Zod schemas expose a `.parse` method that throws the public
// `ZodError`; Zod Mini schemas do not. Detecting it lets `Tool.parse` preserve
// each schema flavour's native error type instead of always surfacing the
// lower-level core `$ZodError`.
function hasParseMethod(
  schema: unknown,
): schema is { parse: (input: unknown) => unknown } {
  return (
    typeof schema === 'object' &&
    schema !== null &&
    'parse' in schema &&
    typeof (schema as { parse: unknown }).parse === 'function'
  );
}

class Tool<TSchema extends z4.$ZodType = z4.$ZodType, TResult = unknown> {
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
    return z4.toJSONSchema(this.inputSchema) as object;
  }

  parse(input: unknown): unknown {
    const schema = this.inputSchema;
    if (!schema) return input;
    // Route classic schemas through their own `.parse` so the thrown error
    // type matches what consumers caught before this refactor; Mini schemas
    // fall back to the shared core parser.
    if (hasParseMethod(schema)) return schema.parse(input);
    return z4.parse(schema, input);
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
  type SessionState,
  type StopReason,
  type ToolContext,
  type ToolRegistry,
};
