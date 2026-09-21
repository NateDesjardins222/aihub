# Contract identity

Atlas distinguishes four things that were previously all "NQ":

| Type | Example | What it is |
| --- | --- | --- |
| `RootInstrument` | NQ | the product line and its economics (tick, multiplier, venue) |
| `TradableContract` | NQZ26 | a specific listed contract that expires |
| `ContinuousSeries` | NQ.c.0 | a stitched front-month series a chart draws; not tradable |
| `ProviderInstrument` | `{yahoo, NQ=F}` | how one vendor names an instrument |

Types and the resolver live in `packages/instruments/src/identity.ts`.

## The resolver boundary

`ContractResolver` turns a root plus an instant into the contract that was the
front month then, deterministically, from the exchange listing cycle and roll
rule (`resolveActiveContract`). It makes no vendor call and invents no roll
behaviour Atlas does not have.

```
contractResolver.resolveTradableContract({ root: 'NQ', timestamp })  // → NQZ26 …
contractResolver.contractCode('NQ', timestamp)                       // → "NQZ26" | null
contractResolver.resolveContinuousSeries('NQ')                       // → NQ.c.0
contractResolver.providerInstrument('yahoo', 'NQ', timestamp)
```

`contractCode` returns `null` for an unknown or unresolvable root — never a
wrong code.

## Persistence

Migration `0012` adds a nullable `contract_code` (varchar 24) to `orders`,
`executions` and `trades`, with contract indexes on the fill and trade tables.
The engine stamps the resolved contract:

- on each **order**, at its market instant (the contract it intended);
- on each **execution**, at the fill instant (the contract it happened in);
- on each **trade**, at the entry instant (the contract the round-trip traded).

The **root** is kept alongside for convenient querying. `null` means the row was
written before contract identity, or the root could not be resolved — "root
only", never a wrong contract. An `NQZ26` fill and an `NQH27` fill are now
different rows.

## Chart vs execution

The chart may draw a `ContinuousSeries`; an order always resolves to a
`TradableContract`. The resolver is the boundary between them.

## Deliberately not done

- Existing rows are **not** back-filled (a safe migration leaves them `null`);
  back-filling would require historical resolution and is deferred.
- `positions` keeps its `(account, root)` key and its `market_era`; per-contract
  position identity across a roll is future work — the fill and trade records
  already carry the contract.
- No provider-specific contract symbols (Rithmic/CQG/Databento) are populated;
  `providerSymbols` carries only what the spec declares (e.g. Yahoo).
