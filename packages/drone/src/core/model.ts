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

abstract class Model {
  abstract createMessage(
    params: CreateMessageParams,
  ): Promise<CreateMessageResponse>;
  abstract searchWeb(query: string, opts?: SearchOptions): Promise<SearchHit[]>;
}

export { Model, type LiteralUnion };
