import type {
  CreateMessageParams,
  CreateMessageResponse,
  SearchHit,
  SearchOptions,
} from './tool';

// Preserves literal autocompletion in `T | string` unions: the `& {}` branch
// stops TypeScript from widening the whole union to `string`, while still
// accepting any string at the call site.
type LiteralUnion<T extends string> = T | (string & {});

// Unified reasoning-effort scale across providers. Matches the Codex CLI enum
// and `pi-mono`. Each model adapter is responsible for mapping a level onto
// the provider's wire format (or collapsing/dropping levels the provider does
// not support).
type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

abstract class Model {
  abstract createMessage(
    params: CreateMessageParams,
  ): Promise<CreateMessageResponse>;
  abstract searchWeb(query: string, opts?: SearchOptions): Promise<SearchHit[]>;
}

export { Model, type LiteralUnion, type ThinkingLevel };
