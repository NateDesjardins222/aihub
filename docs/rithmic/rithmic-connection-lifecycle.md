# Rithmic Connection Lifecycle (Milestone 9)

## Plants
Distinct logical connections, each its own state machine (`rithmic/plants/plant.ts`),
coordinated by `RithmicConnectionManager`: DISCOVERY (one-shot), TICKER, ORDER,
HISTORY, PNL, REPOSITORY. `infra_type` per plant is resolved from the schema enum,
never hardcoded.

## States
`DISCONNECTED → CONNECTING → CONNECTED → AUTHENTICATING → AUTHENTICATED →
(DEGRADED) → RECONNECTING → FAILED / STOPPED`. **An open socket is not healthy:**
`isHealthy()` requires AUTHENTICATED *and* recent protocol activity (heartbeat/
message inside the liveness window).

## Discovery
`RequestRithmicSystemInfo` → parse system names → verify "Rithmic Test" present →
close. Bounded cache; honest `SYSTEM_ABSENT` / `ENDPOINT_UNAVAILABLE` / `TIMEOUT` /
`MALFORMED_RESPONSE`. Never silently falls back to another environment.

## Authentication
`RequestLogin` with the schema-correct fields (user, password, app_name,
app_version, system_name, infra_type, template_version). `ResponseLogin.rp_code[0]`
== "0" → AUTHENTICATED; otherwise mapped to a canonical error (AUTH_FAILED,
AGREEMENT_REQUIRED, PERMISSION_DENIED, SYSTEM_UNAVAILABLE, TIMEOUT,
TRANSPORT_ERROR, PROTOCOL_ERROR, UNKNOWN). A hard auth rejection is terminal
(FAILED, no reconnect). Passwords never enter state/metrics/logs/errors.

## Heartbeat / liveness
Server-dictated interval (`heartbeat_interval` from ResponseLogin). Outbound
`RequestHeartbeat`; inbound heartbeats + any message feed the watchdog. Silence
past the liveness timeout → DEGRADED → reconnect.

## Reconnect / recovery
Bounded exponential backoff + jitter (`connection-lifecycle.ts`), never a storm.
On reconnect: re-authenticate the plant, restore subscriptions (market-data
re-subscribe, order-update re-subscribe) and reconcile. A disconnect never implies
an order failed — recovery reconciles authoritative state.

## Metrics (redacted)
connectedAt, authenticatedAt, lastMessageAt, lastHeartbeatSent/ReceivedAt,
reconnectCount, lastDisconnectReason, lastErrorCode/At, messagesReceived,
decodeErrors — plus process counters in `rithmic/metrics.ts`.
