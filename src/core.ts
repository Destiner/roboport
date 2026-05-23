import type { z } from 'zod';

type MaybePromise<T> = T | Promise<T>;

class Model {
  modelName: string;
  options: {
    apiKey?: string;
  };

  constructor(
    modelName: string,
    options?: {
      apiKey?: string;
    },
  ) {
    this.modelName = modelName;
    this.options = options || {};
  }
}

class Tool<TSchema extends z.ZodTypeAny = z.ZodTypeAny, TResult = unknown> {
  name: string;
  description: string;
  inputSchema: TSchema;
  execute: (input: z.infer<TSchema>) => MaybePromise<TResult>;

  constructor({
    name,
    description,
    inputSchema,
    execute,
  }: {
    name: string;
    description: string;
    inputSchema: TSchema;
    execute: (input: z.infer<TSchema>) => MaybePromise<TResult>;
  }) {
    this.name = name;
    this.description = description;
    this.inputSchema = inputSchema;
    this.execute = execute;
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
}

export { Model, Tool, Skill, Agent };
