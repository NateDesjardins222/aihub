# 06 — Diagnostics: "What Happened?"

`support-diagnostics.ts` powers the panel a support agent opens on a linked object.
Its entire purpose is to replace guesswork with **recorded facts**. Everything it
returns is read from server-authoritative tables and engines — order reject
reasons, payout eligibility, account drawdown/status, provisioning, refund
eligibility. There is no generative reasoning presented as truth.

## `whatHappened(db, org, objectType, objectId)`

Returns a deterministic `Diagnostic`:

```ts
{ objectType, objectId, headline, facts: [{ label, value }], reasonCodes: string[] }
```

The `headline` restates the recorded state, `facts` are the concrete values, and
`reasonCodes` are the machine reason codes the engines emitted. Supported object
types:

- **`order`** — reads `orders`: symbol, side, qty, type, status, filled qty, and
  the `reject_reason` when present. A rejected order's headline is
  `Order rejected: <reason>` and the reject reason becomes the sole reason code.
- **`payout`** — reads the payout inspector (`inspectPayout`): state-machine state,
  eligibility state, gross withdrawable (micros → dollars), qualifying winning
  days, consistency ratio, the daily qualifying-balance figures when present, and
  an enforcement-hold flag. Reason codes come straight from the eligibility
  engine.
- **`account`** — reads the account inspector (`inspectAccount`): status, rule
  status, balance, starting balance, drawdown band/floor/headroom, admin hold and
  trading hold. A `BREACHED` drawdown band yields `MAX_LOSS_BREACH`.
- **`purchase` / `reset`** — reads `commercial_orders`: source, status, amount,
  the provisioned account (if any), refunded flag, provision note, and the
  **ordinary refund eligibility** verdict (below), whose reason becomes the reason
  code.
- **`certificate`** — reads `certificates`: type, public id, status.
- anything else — a stated "no automated diagnostic for `<type>`" placeholder.

Any lookup error is caught and returned as `Diagnostic unavailable` with a short
error string — the panel degrades honestly rather than fabricating a result.
Money values are formatted from integer micros.

The staff route is `GET /support/diagnostics?objectType=&objectId=`
(`support.read`).

## `refundEligibility(db, org, orderId)` — ordinary refund only

This is the deterministic gate for an **ordinary** purchase refund. The rule:
*an ordinary refund is allowed only if the provisioned account has no executed
trade.* It reads `commercial_orders` and counts `executions` on the provisioned
account, returning `{ eligible, reason, detail }` with one of these reason codes:

| Reason code | Meaning | Eligible? |
| --- | --- | --- |
| `ORDER_NOT_FOUND` | no such order in this org | no |
| `ALREADY_REFUNDED` | the order was already refunded | no |
| `ORDER_NOT_SETTLED:<status>` | status is not `COMPLETED`/`PROVISIONED` | no |
| `NO_ACCOUNT_PROVISIONED` | no account was provisioned; nothing to have traded | **yes** |
| `TRADE_EXECUTED` | the provisioned account has ≥ 1 execution | no |
| `NO_TRADE_EXECUTED` | the provisioned account has zero executions | **yes** |

The staff route is `GET /support/refund-eligibility?orderId=` (`support.read`).

## Ordinary vs exception refunds

`refundEligibility` governs the **ordinary** case only. A **duplicate charge** or a
**platform-caused (technical) issue** is a different situation: the account may well
have traded, yet the customer is still owed a correction. Those are handled through
the remediation workflow as an *exception* refund (see doc 07), which bypasses the
ordinary trade check on purpose — never by faking the eligibility result. This
separation is deliberate: the deterministic check protects against refunding a
funded, traded account by mistake, while genuine billing errors still have a path.
