import type { Tool } from './tool';

interface McpClient {
  connect(): Promise<Tool[]>;
  disconnect(): Promise<void>;
}

// eslint-disable-next-line import-x/prefer-default-export
export type { McpClient };
