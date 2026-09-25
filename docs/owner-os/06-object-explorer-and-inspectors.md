# Owner OS — Object Explorer & State Inspectors

The console can explain any object in the system without a raw JSON dump, and can
inspect the *why* behind a payout or account state by consuming the server's own
reason codes.

Modules: `object-explorer.ts`, `inspectors.ts`
Routes: `/api/v1/admin/ops/objects/:type/:id`, `/inspect/payout/:id`,
`/inspect/account/:id`

## Universal object explorer

`explainObject(db, org, type, id)` returns a normalized `{ type, id, title, state,
related[], history[] }` for:

- **account** — status, rule status, holds, drawdown band, balance; owner link;
  recent account audit.
- **payout** — state-machine position + valid next states, eligibility state and
  reason codes; account link.
- **customer** — email/role/status/identity/account count; account links; recent
  user audit.
- **staff** — role/status/MFA/active sessions/effective permissions; recent audit.
- **certificate** — type/public id/status and a **masked** verification token
  hint (`abcd…`). The raw token is never returned.

An unsupported type is refused with `UNSUPPORTED_OBJECT` (400) rather than dumping
a row. `explainObject` never returns password material.

## Inspectors consume server-authoritative reason codes

`inspectPayout(db, id)` reports the real eligibility evaluation
(`evaluatePayoutEligibility`) — its `state` and `reasonCodes` — plus the real
payout state machine (`PAYOUT_TRANSITIONS`): current state, whether it is terminal,
and the valid next transitions. The inspector does **not** re-derive eligibility;
it renders what the payout engine decided.

`inspectAccount(db, id)` reports the drawdown band, rule status, holds, and
lifecycle history from the authoritative account read model.

`payoutStateMachine(current)` is a pure helper returning `{ current, terminal,
validNext }` used by both the inspector and the object explorer, so the console and
the engine can never disagree about what a payout can do next.
