# Owner OS — Alerts & Incidents

Modules: `alerts.ts`, `incidents.ts`
Routes: `/api/v1/admin/ops/alerts...`, `/incidents...`

## Alerts — deduplicated, never a storm

`raiseAlert(...)` coalesces on a dedupe key: a storm of identical raises produces
**one** alert with an incrementing `count`, not hundreds of notifications. Severity
escalates to the highest seen while the alert is open. A resolved alert no longer
coalesces — a fresh raise opens a new alert.

Lifecycle: OPEN → (`ack`) ACKNOWLEDGED → (`resolve`) RESOLVED. `alertSummary`
counts OPEN alerts by severity. Reads require `alerts.read`; ack/resolve require
`alerts.manage`.

## Notification channels are truthful

`notificationChannels()` reports the real posture: `IN_APP` is configured; external
channels (email/SMS) report `NOT_CONFIGURED` when their provider credentials are
absent. The console never shows a channel as ready when it is not.

## Incidents — group many failures into one investigable record

`openOrGroupIncident(...)` is idempotent on an open dedupe key: a provider outage
that trips hundreds of alerts becomes **one** incident, not hundreds. Different
dedupe keys open distinct incidents; a resolved incident no longer groups (a
recurrence opens a fresh one).

Lifecycle state machine (`canTransitionIncident`):

```
OPEN → ACKNOWLEDGED | INVESTIGATING | MONITORING | RESOLVED
ACKNOWLEDGED → INVESTIGATING | IDENTIFIED | MONITORING | RESOLVED
INVESTIGATING → IDENTIFIED | MONITORING | RESOLVED
IDENTIFIED → MONITORING | RESOLVED
MONITORING → RESOLVED | INVESTIGATING
RESOLVED → INVESTIGATING            (reopen on recurrence)
```

Illegal jumps (e.g. RESOLVED → OPEN, OPEN → IDENTIFIED) are refused with
`INVALID_TRANSITION`. Resolving records a resolution; `assignIncident` records an
owner; `linkToIncident` attaches related objects that surface in the detail;
`incidentSummary` counts only non-resolved incidents. Managing incidents requires
`system.incidents.manage`; reading requires `system.read`.
