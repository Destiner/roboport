---
'roboport': patch
---

Add OpenTelemetry instrumentation. Emits GenAI-convention traces (`agent.turn`, `chat.model`, `tool.execute`, `mcp.connect`/`mcp.request`, `channel.receive`/`channel.send`, `trigger.receive`/`trigger.send`) and metrics (token counter, turn-duration histogram, tool-error counter) against the global `@opentelemetry/api`. Bring your own SDK and exporter; no-op when none is registered. Set `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` to attach prompt/completion and tool content to spans.
