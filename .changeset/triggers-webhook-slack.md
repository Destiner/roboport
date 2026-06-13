---
'roboport': minor
---

Add `slack` and `webhook` triggers to `roboport/triggers`. `slack` is a Slack
Events API receiver (signature + replay verification, url_verification
challenge, event_id dedup) exposing `appMention`, `message`, and `reaction`
subscriptions, plus a `SlackClient` for outbound replies. Slack Web API failures
throw a typed `SlackApiError` carrying the stable `error` code, HTTP status, and
`Retry-After` delay on throttling. `webhook` is a generic JSON receiver for
sources without a dedicated preset, with optional HMAC signature verification
and id-based dedup; `event<T>()` types the parsed `body`. Providing an empty
`secret` to `webhook` throws so a missing env var fails fast instead of silently
running unsigned.
