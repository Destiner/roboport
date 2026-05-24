import { z } from 'zod';

import type {
  Message,
  TextPart,
  ToolCallPart,
  ToolResultPart,
} from './message';
import type { Subscription, Trigger, Unsub } from './triggers/core';

type MaybePromise<T> = T | Promise<T>;

// Preserves literal autocompletion in `T | string` unions: the `& {}` branch
// stops TypeScript from widening the whole union to `string`, while still
// accepting any string at the call site.
type LiteralUnion<T extends string> = T | (string & {});

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

abstract class Model {
  abstract createMessage(
    params: CreateMessageParams,
  ): Promise<CreateMessageResponse>;
  abstract searchWeb(query: string, opts?: SearchOptions): Promise<SearchHit[]>;
}

interface McpClient {
  connect(): Promise<Tool[]>;
  disconnect(): Promise<void>;
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

class Skill {
  name: string;
  description: string;
  content: string;

  constructor({
    name,
    description,
    content,
  }: {
    name: string;
    description: string;
    content: string;
  }) {
    this.name = name;
    this.description = description;
    this.content = content;
  }
}

interface Session {
  messages: Message[];
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

interface Registration<T = unknown> {
  trigger: Trigger<T>;
  subscription: Subscription<T>;
}

class Agent {
  model: Model;
  prompt: string;
  tools: Tool[];
  skills: Skill[];
  mcp: McpClient[];
  private registrations: Registration[] = [];
  private unsubs: Unsub[] = [];

  constructor({
    model,
    prompt,
    tools,
    skills,
    mcp,
  }: {
    model: Model;
    prompt: string;
    tools: Tool[];
    skills: Skill[];
    mcp?: McpClient[];
  }) {
    this.model = model;
    this.prompt = prompt;
    this.tools = tools;
    this.skills = skills;
    this.mcp = mcp ?? [];
  }

  on<T>(trigger: Trigger<T>, subscription: Subscription<T>): void {
    this.registrations.push({
      trigger,
      subscription,
    } as Registration);
  }

  async start(): Promise<void> {
    for (const { trigger, subscription } of this.registrations) {
      const unsub = await trigger.start(async (event) => {
        try {
          const prompt =
            typeof subscription.prompt === 'function'
              ? await subscription.prompt(event)
              : subscription.prompt;
          await this.createSession({ prompt });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          console.error(
            `[drone] trigger "${trigger.name}" handler failed: ${message}`,
          );
        }
      });
      this.unsubs.push(unsub);
    }
  }

  async stop(): Promise<void> {
    const unsubs = this.unsubs;
    this.unsubs = [];
    await Promise.all(unsubs.map((u) => u()));
  }

  buildSystem(allTools: Tool[]): string {
    let system = this.prompt;
    if (this.skills.length > 0) {
      const skillsList = this.skills
        .map((skill) => `- ${skill.name}: ${skill.description}`)
        .join('\n');
      system = `${system}\n\n# Skills\nThe following skills are available. When a task matches one, call the \`Skill\` tool with that skill's name to load its full content before proceeding.\n\n${skillsList}`;
    }
    const deferred = allTools.filter((tool) => tool.deferred);
    if (deferred.length > 0) {
      const list = deferred.map((tool) => `- ${tool.name}`).join('\n');
      system = `${system}\n\n# Deferred tools\nThese tools are available but their schemas are not loaded. Use ToolSearch to load them before calling.\n${list}`;
    }
    return system;
  }

  private buildSkillTool(): Tool {
    const byName = new Map(this.skills.map((skill) => [skill.name, skill]));
    return new Tool({
      name: 'Skill',
      description:
        'Load the full content of a skill listed under "# Skills" in the system prompt. Call this when you decide a listed skill applies to the current task; the returned content extends your instructions for the rest of the session.',
      inputSchema: z.object({
        skill: z
          .string()
          .describe('Name of the skill to load (must match a listed skill).'),
      }),
      execute: ({ skill }): string => {
        const found = byName.get(skill);
        if (!found) {
          const available = [...byName.keys()].join(', ');
          throw new Error(
            `Skill "${skill}" not found. Available: ${available}`,
          );
        }
        return `<skill name="${found.name}">\n${found.content}\n</skill>`;
      },
    });
  }

  async createSession({ prompt }: { prompt: string }): Promise<Session> {
    const mcpToolGroups = await Promise.all(
      this.mcp.map((mcp) => mcp.connect()),
    );
    const allTools = [
      ...this.tools,
      ...mcpToolGroups.flat(),
      ...(this.skills.length > 0 ? [this.buildSkillTool()] : []),
    ];

    try {
      const state: SessionState = {
        messages: [
          { role: 'system', content: this.buildSystem(allTools) },
          { role: 'user', content: prompt },
        ],
        store: new Map(),
      };

      const registry = createRegistry(allTools);

      const ctx: ToolContext = {
        complete: async (p: string): Promise<string> => {
          const response = await this.model.createMessage({
            messages: [{ role: 'user', content: p }],
          });
          return response.content
            .filter((block): block is TextPart => block.type === 'text')
            .map((block) => block.text)
            .join('\n');
        },
        searchWeb: (query, opts) => this.model.searchWeb(query, opts),
        session: state,
        tools: registry,
      };

      while (true) {
        const active = registry.loaded();
        const toolByName = new Map(active.map((tool) => [tool.name, tool]));

        const response = await this.model.createMessage({
          messages: state.messages,
          tools: active,
        });

        state.messages.push({ role: 'assistant', content: response.content });

        if (response.stopReason !== 'tool_use') break;

        const toolCalls = response.content.filter(
          (block): block is ToolCallPart => block.type === 'tool-call',
        );

        const results: ToolResultPart[] = [];
        for (const call of toolCalls) {
          const tool = toolByName.get(call.toolName);
          if (!tool) {
            results.push({
              type: 'tool-result',
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              output: `Error: tool "${call.toolName}" not found`,
            });
            continue;
          }
          try {
            const parsed = tool.parse(call.input);
            const output = await tool.execute(parsed, ctx);
            results.push({
              type: 'tool-result',
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              output,
            });
          } catch (error) {
            results.push({
              type: 'tool-result',
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              output: `Error: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
        }

        state.messages.push({ role: 'tool', content: results });
      }

      return { messages: state.messages };
    } finally {
      await Promise.all(this.mcp.map((mcp) => mcp.disconnect()));
    }
  }
}

export {
  Model,
  Tool,
  Skill,
  Agent,
  type Session,
  type SessionState,
  type ToolContext,
  type ToolRegistry,
  type SearchHit,
  type SearchOptions,
  type CreateMessageParams,
  type CreateMessageResponse,
  type StopReason,
  type McpClient,
  type LiteralUnion,
};
