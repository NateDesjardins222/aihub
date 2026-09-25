# Rithmic Execution Lifecycle (Milestone 9)

ORDER plant, behind Atlas's `ExternalExecutionAdapter` seam. Atlas order ids are
canonical; the Rithmic `basket_id` is stored alongside.

## Discovery
`RequestAccountList` → provider accounts (fcm/ib/account_id, never keyed by email).
`RequestTradeRoutes` → routes; the default route for the instrument's exchange is
chosen (never a hardcoded route). `RequestSubscribeForOrderUpdates` per account.

## Submit
`RequestNewOrder` built from the intent: BUY/SELL, DAY/GTC, MARKET/LIMIT/
STOP_MARKET/STOP_LIMIT, `quantity_64`, discovered route, AUTO manual/auto
designation (Atlas-generated), and `user_tag` = the stable client order id
(idempotency + correlation). Enum values come from the schema.

Outcomes: **SUBMITTED** (basket id known), **REJECTED** (hard, never retried), or
**SUBMISSION_UNKNOWN** (ack lost — the trading equivalent of the M8 lost-ack rule:
reconcile, NEVER blindly resubmit). A timeout is not proof of rejection.

## Ack ≠ fill
A provider ack marks the order working. A **fill** is only an
ExchangeOrderNotification of type FILL → PARTIALLY_FILLED / FILLED by unfilled
size. The Atlas simulator never fills a Rithmic-routed order.

## Executions
`ExchangeOrderNotification` / `RithmicOrderNotification` → normalized
ExecutionReport. Fills carry a stable dedup key (`basket|trade|fill|ts`); a
replayed fill is ignored (`duplicate_executions_ignored`). DB-level dedup is
enforced by `external_execution_events.dedupe_key` (M4).

## Modify / cancel
Provider-native `RequestModifyOrder` / `RequestCancelOrder` by basket id. A local
Atlas mutation is not a provider modification — state changes only on the
authoritative provider response/update. Races (cancel vs fill, partial during
modify, disconnect during cancel) resolve via reconciliation.

## P&L / positions
PNL plant: `RequestPnLPositionUpdates` → Instrument/Account PnLPositionUpdate,
normalized as the provider's view — never used to overwrite Happy Trader's ledger;
differences are surfaced by reconciliation.

## Brackets / OCO
Decode-capable; native provider bracket submission is **deferred to M9.1** to avoid
destabilizing the simulation bracket engine. The capability seam exists; enabling
native brackets requires proving lifecycle correctness first.
