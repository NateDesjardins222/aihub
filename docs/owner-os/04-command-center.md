# Owner OS — Command Center

The Command Center is the owner's landing surface. It answers one question from
real, server-authoritative data: **"Does Happy Trader need my attention right
now?"**

Module: `apps/server/src/platform/command-center.ts`
Routes: `GET /api/v1/admin/ops/command-center`, `GET /api/v1/admin/ops/daily-brief`
Web: `apps/web/src/admin/pages/OwnerOsPages.tsx` (`CommandCenterPage`)

## What it aggregates

`commandCenter(db, org)` runs, in parallel, the authoritative subsystems and
composes their output — it never recomputes business rules:

- **System Doctor** overall status (`runSystemDoctor`)
- **Data Integrity** report (`runIntegrityChecks`)
- **Financial summary** (`financialSummary`) — liability, paid, revenue
- **Alerts** summary (`alertSummary`)
- **Incidents** summary (`incidentSummary`)
- **Jobs** summary (`jobsSummary`) — dead-letter count
- **Provisioning exceptions** (`provisioningExceptionQueue`)

## Output shape

- `overall`: `HEALTHY` | `DEGRADED` | `CRITICAL`. It is `CRITICAL` if the doctor
  is CRITICAL or any integrity check FAILs; `DEGRADED` if the doctor warns or
  anything needs attention; otherwise `HEALTHY`. A dead-letter job or an integrity
  failure can never read HEALTHY.
- `health`: doctor status, integrity OK flag, and the doctor's per-check rows.
- `kpis`: total/new customers, active funded accounts, active evaluations, pending
  payouts, payouts paid today, payout liability, paid trader payouts, purchase
  revenue, open incidents, open critical alerts, dead-letter jobs, integrity
  failures, provisioning exceptions.
- `attention`: an **Attention Required** list. Each item carries a severity and a
  `link` to the real object/surface (e.g. `/admin/ops/jobs?state=dead`,
  `/admin/ops/provisioning`, `/admin/ops/integrity`). Nothing here is decorative;
  every item is actionable.
- `recentActions`: the last 15 high-impact admin actions from `audit_log`.
- `at`: the ISO timestamp the aggregate was computed.

## Daily brief

`dailyBrief(db, org)` renders the same authoritative numbers as a short factual
operations brief (date, overall, one line per KPI). It fabricates nothing; it is a
plain-language projection of the Command Center KPIs.

## Design

The web page uses the shared admin kit (`Panel`, `Stat`, `Money`, `StatusPill`)
and a dark/light toggle in the header. Statuses render exactly what the server
reports — no green is faked. The environment badge reads the server's
`EXTERNAL_LIVE` gate and shows `SIMULATION` while it is off.
