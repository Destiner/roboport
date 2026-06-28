// Gated on an OTLP endpoint being configured: unset means no SDK starts, so
// roboport stays a no-op and local runs never reach for the OTLP default
// localhost:4318 collector. Honors the signal-specific endpoint vars too, which
// OTel lets override the generic one. When set (Railway secrets in production),
// the exporters read the endpoint plus OTEL_EXPORTER_OTLP_HEADERS from the env.
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';

const otlpConfigured =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
  process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;

if (otlpConfigured) {
  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'roboport-bot',
    traceExporter: new OTLPTraceExporter(),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
    }),
  });

  sdk.start();

  // Flush buffered spans/metrics on shutdown so the last turn isn't lost.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void sdk.shutdown().finally(() => process.exit(0));
    });
  }
}
