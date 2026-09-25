# Rithmic Local Setup (Milestone 9)

**Rithmic Test only. Never commit credentials or the vendor package.**

## Prerequisites (owner, one-time)
1. In **R|Trader Pro Desktop**, log into **Rithmic Test** (gateway: Orangeburg),
   authenticate, and accept/sign the required Rithmic agreements.
2. Obtain Rithmic developer access to the official **RProtocolAPI.0.90.0.0** package.

## 1) The official package (gitignored)
Drop the package's proto files here (never committed):
```
apps/server/vendor/rithmic/proto/*.proto
```
Then bind them into the runtime registry:
```
pnpm --filter @atlas/server rithmic:generate
```
Without the package, Atlas uses the committed **test-double** schema for
deterministic tests only, and the live transport reports UNCONFIGURED.

## 2) Environment (local .env only — placeholders in .env.example)
```
RITHMIC_ENABLED=true
RITHMIC_ENVIRONMENT=TEST
RITHMIC_ENDPOINT=wss://rituz00100.rithmic.com:443
RITHMIC_SYSTEM_NAME=Rithmic Test
RITHMIC_MARKET_DATA_ENABLED=true
RITHMIC_EXECUTION_ENABLED=true
RITHMIC_USER=            # never commit
RITHMIC_PASSWORD=        # never commit
```
`EXTERNAL_LIVE_ENABLED` stays `false`. To make Rithmic the dev market source:
`MARKET_DATA_PROVIDER=rithmic` (fail-fast if unconfigured — never a silent Yahoo
fallback).

## 3) Verify (safe live acceptance)
```
pnpm --filter @atlas/server rithmic:verify
```
It runs discovery → plant auth → accounts → routes → market data → history, and
reports any steps blocked by market state/entitlement. It prints no credential.
Order submit/cancel is a supervised follow-up (`VERIFY_SUBMIT=1`) using a single
far-from-market limit order.

## Troubleshooting
- **SYSTEM_ABSENT**: the login system name doesn't match a discovered system.
- **AGREEMENT_REQUIRED**: sign the agreements in R|Trader Pro first.
- **No market ticks**: market closed or entitlement-limited — reported as BLOCKED,
  not a failure.
- **UNCONFIGURED**: a required RITHMIC_* var is missing (the error names which).
