---
'roboport': minor
---

Add an `OpenRouter` model adapter (`roboport/models`), reaching OpenRouter's full catalogue behind one `OPENROUTER_API_KEY`. All six thinking levels map onto `reasoning.effort` without clamping, `searchWeb` uses the server-side `web` plugin, and `reasoning_details` are replayed verbatim on later turns so reasoning models stay coherent across tool calls.

`OpenAICompatible` grows three protected seams for subclasses: `extraHeaders()`, `createReasoningAccumulator()` for providers that don't use `reasoning_content`, and an optional second `thinking` argument to `adaptAssistantWire()`.
