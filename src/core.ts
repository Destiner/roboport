import { z } from 'zod';

import type {
  Message,
  TextPart,
  ToolCallPart,
  ToolResultPart,
} from './message';

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

class Tool<TSchema extends z.ZodTypeAny = z.ZodTypeAny, TResult = unknown> {
  name: string;
  description: string;
  inputSchema: TSchema;
  execute: (input: z.infer<TSchema>, ctx: ToolContext) => MaybePromise<TResult>;
  deferred: boolean;

  constructor({
    name,
    description,
    inputSchema,
    execute,
    deferred,
  }: {
    name: string;
    description: string;
    inputSchema: TSchema;
    execute: (
      input: z.infer<TSchema>,
      ctx: ToolContext,
    ) => MaybePromise<TResult>;
    deferred?: boolean;
  }) {
    this.name = name;
    this.description = description;
    this.inputSchema = inputSchema;
    this.execute = execute;
    this.deferred = deferred ?? false;
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

class Agent {
  model: Model;
  prompt: string;
  tools: Tool[];
  skills: Skill[];

  constructor({
    model,
    prompt,
    tools,
    skills,
  }: {
    model: Model;
    prompt: string;
    tools: Tool[];
    skills: Skill[];
  }) {
    this.model = model;
    this.prompt = prompt;
    this.tools = tools;
    this.skills = skills;
  }

  buildSystem(): string {
    let system = this.prompt;
    if (this.skills.length > 0) {
      const skillsList = this.skills
        .map((skill) => `- ${skill.name}: ${skill.description}`)
        .join('\n');
      system = `${system}\n\n# Skills available\n${skillsList}`;
    }
    const deferred = this.tools.filter((tool) => tool.deferred);
    if (deferred.length > 0) {
      const list = deferred.map((tool) => `- ${tool.name}`).join('\n');
      system = `${system}\n\n# Deferred tools\nThese tools are available but their schemas are not loaded. Use ToolSearch to load them before calling.\n${list}`;
    }
    return system;
  }

  async createSession({ prompt }: { prompt: string }): Promise<Session> {
    const state: SessionState = {
      messages: [
        { role: 'system', content: this.buildSystem() },
        { role: 'user', content: prompt },
      ],
      store: new Map(),
    };

    const registry = createRegistry(this.tools);

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
          const parsed = tool.inputSchema.parse(call.input);
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
};
