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

class Tool {
  name: string;
  description: string;
  func: () => void;

  constructor({
    name,
    description,
    func,
  }: {
    name: string;
    description: string;
    func: () => void;
  }) {
    this.name = name;
    this.description = description;
    this.func = func;
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
