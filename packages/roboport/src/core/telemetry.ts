// OpenTelemetry instrumentation, emitted against the global `@opentelemetry/api`.
// roboport never registers an SDK — bring your own (`@opentelemetry/sdk-node`
// + an OTLP exporter, where the export URL lives). With no SDK registered the
// API hands back no-op tracers/meters, so this module is inert and adds no
// overhead for consumers who don't opt in.

import {
  type Attributes,
  type Counter,
  type Histogram,
  type Link,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  SpanStatusCode,
  type Tracer,
  context,
  metrics,
  propagation,
  trace,
} from '@opentelemetry/api';

const INSTRUMENTATION_NAME = 'roboport';
const INSTRUMENTATION_VERSION = '0.7.0';

// GenAI semantic-convention attribute keys (kept as inline literals so we don't
// pull in @opentelemetry/semantic-conventions just for a handful of strings).
const ATTR = {
  operationName: 'gen_ai.operation.name',
  requestModel: 'gen_ai.request.model',
  responseFinishReasons: 'gen_ai.response.finish_reasons',
  usageInputTokens: 'gen_ai.usage.input_tokens',
  usageOutputTokens: 'gen_ai.usage.output_tokens',
  toolName: 'gen_ai.tool.name',
  toolCallId: 'gen_ai.tool.call.id',
  tokenType: 'gen_ai.token.type',
  // roboport-specific
  promptContent: 'roboport.prompt.content',
  completionContent: 'roboport.completion.content',
  toolArguments: 'roboport.tool.arguments',
  toolResult: 'roboport.tool.result',
} as const;

function tracer(): Tracer {
  return trace.getTracer(INSTRUMENTATION_NAME, INSTRUMENTATION_VERSION);
}

// Metric instruments are created lazily on first use and cached. The meter is
// resolved at that point, so an SDK registered before the first agent run is
// picked up.
let tokenCounter: Counter | undefined;
let turnDuration: Histogram | undefined;
let toolErrorCounter: Counter | undefined;

function meter(): ReturnType<typeof metrics.getMeter> {
  return metrics.getMeter(INSTRUMENTATION_NAME, INSTRUMENTATION_VERSION);
}

function recordTokens(
  model: string | undefined,
  usage: { inputTokens: number; outputTokens: number },
): void {
  tokenCounter ??= meter().createCounter('roboport.gen_ai.client.tokens', {
    description: 'Tokens consumed by model calls.',
    unit: '{token}',
  });
  const base: Attributes = model ? { [ATTR.requestModel]: model } : {};
  if (usage.inputTokens > 0) {
    tokenCounter.add(usage.inputTokens, { ...base, [ATTR.tokenType]: 'input' });
  }
  if (usage.outputTokens > 0) {
    tokenCounter.add(usage.outputTokens, {
      ...base,
      [ATTR.tokenType]: 'output',
    });
  }
}

function recordTurnDuration(seconds: number, attributes?: Attributes): void {
  turnDuration ??= meter().createHistogram('roboport.gen_ai.turn.duration', {
    description: 'Duration of an agent turn.',
    unit: 's',
  });
  turnDuration.record(seconds, attributes);
}

function recordToolError(toolName: string): void {
  toolErrorCounter ??= meter().createCounter('roboport.gen_ai.tool.errors', {
    description: 'Tool executions that ended in an error.',
    unit: '{error}',
  });
  toolErrorCounter.add(1, { [ATTR.toolName]: toolName });
}

// Whether to attach prompt/completion and tool argument/result content to
// spans. Off by default; gated by the OTEL-conventional env var so enabling it
// is a deploy-time decision, not a code change. Read lazily — the value can be
// set before the process boots roboport.
function captureContent(): boolean {
  const raw =
    process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT?.toLowerCase();
  return raw === 'true' || raw === '1';
}

interface SpanOptions {
  kind?: SpanKind;
  attributes?: Attributes;
  links?: Link[];
}

// Runs `fn` inside an active span: child spans created within (including across
// awaited async calls, given an AsyncLocalStorage-based context manager from
// the SDK) nest under it. Records exceptions and marks the span errored before
// rethrowing, and always ends the span.
async function span<T>(
  name: string,
  options: SpanOptions,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer().startActiveSpan(
    name,
    {
      kind: options.kind ?? SpanKind.INTERNAL,
      attributes: options.attributes,
      links: options.links,
    },
    async (active) => {
      try {
        return await fn(active);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        active.recordException(err);
        active.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        throw error;
      } finally {
        active.end();
      }
    },
  );
}

// Starts a span as a child of the active context without making it active.
// Use this when the instrumented block has no child spans and its control flow
// (early `break`/`return` within an enclosing loop) can't live inside a
// `startActiveSpan` callback. The caller owns `end()`; `failSpan` records an
// error before ending.
function startSpan(name: string, options: SpanOptions = {}): Span {
  // Pass the active context explicitly: the OTel JS API starts spans against
  // ROOT_CONTEXT otherwise, which would detach this span into its own trace
  // instead of nesting it under the enclosing active span.
  return tracer().startSpan(
    name,
    {
      kind: options.kind ?? SpanKind.INTERNAL,
      attributes: options.attributes,
      links: options.links,
    },
    context.active(),
  );
}

function failSpan(active: Span, error: unknown): void {
  const err = error instanceof Error ? error : new Error(String(error));
  active.recordException(err);
  active.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
}

// Records a webhook-ingress span around a fire-and-forget `dispatch`. The span
// is its own trace root (parented to ROOT_CONTEXT), linked to the upstream
// `traceparent` via `options.links`, and is *never made active*. `dispatch`
// runs under a detached root context, so subscribers that schedule work with
// the ambient context (e.g. `Agent.start`'s fire-and-forget handler) capture a
// clean root rather than nesting their `agent.turn` under this span or the
// caller's server trace.
function ingress(
  name: string,
  options: SpanOptions,
  dispatch: () => void,
): void {
  const active = tracer().startSpan(
    name,
    {
      kind: options.kind ?? SpanKind.SERVER,
      attributes: options.attributes,
      links: options.links,
    },
    ROOT_CONTEXT,
  );
  try {
    context.with(ROOT_CONTEXT, dispatch);
  } catch (error) {
    failSpan(active, error);
    throw error;
  } finally {
    active.end();
  }
}

// Builds a span link to the upstream trace carried in inbound headers (W3C
// `traceparent`). Used for ingress spans (webhooks): the span stays a root of
// roboport's own trace and *links* to the caller's trace rather than nesting
// under it — the right topology when handling is fire-and-forget and shouldn't
// be attributed to the caller's trace. Returns undefined when no valid upstream
// context is present.
function linkFromCarrier(
  carrier: Record<string, string | undefined>,
): Link | undefined {
  // Extract from ROOT_CONTEXT, not the active context: otherwise, with no
  // inbound `traceparent`, `getSpanContext` returns the ambient server span and
  // we would link to our own caller instead of producing no link.
  const upstream = propagation.extract(ROOT_CONTEXT, carrier);
  const spanContext = trace.getSpanContext(upstream);
  return spanContext ? { context: spanContext } : undefined;
}

const telemetry = {
  ATTR,
  SpanKind,
  span,
  startSpan,
  failSpan,
  ingress,
  recordTokens,
  recordTurnDuration,
  recordToolError,
  captureContent,
  linkFromCarrier,
} as const;

// eslint-disable-next-line import-x/prefer-default-export
export { telemetry };
