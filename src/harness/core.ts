import type { Tool } from '@/core';

class Harness {
  system: string;
  tools: Tool[];

  constructor(system: string, tools: Tool[]) {
    this.system = system;
    this.tools = tools;
  }
}

// eslint-disable-next-line import-x/prefer-default-export
export { Harness };
