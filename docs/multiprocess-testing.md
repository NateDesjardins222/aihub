# Multi-process testing

V2 proved concurrency with independent connections in ONE process (SIMULATED
separate processes). This milestone spawns ACTUAL separate OS processes.

`scripts/multiprocess-reliability.ts` (run:
`pnpm --filter @atlas/server exec tsx scripts/multiprocess-reliability.ts`)
forks child processes via `node --import tsx` against one PostgreSQL and proves,
across real process boundaries:

1. **SKIP LOCKED.** 4 worker processes drain one 200-event outbox; each event is
   processed exactly once (a `mp_processed` PK is the cross-process
   delivered-once ledger) and none is lost.
2. **Crash recovery.** A worker is `SIGKILL`ed mid-drain; because its claim's
   transaction rolls back, its rows unlock and another worker finishes — all 120
   events delivered exactly once.
3. **Advisory lock.** 3 processes each run 50 guarded read-modify-write
   increments on one row through `withAccountAdvisoryLock`; the counter ends at
   exactly 150 (no lost update across processes).

Measured run: `[1] 200/200 distinct in ~1.8s  [2] 120/120 after real SIGKILL
[3] 150/150  => ALL PASS`.

What remains SIMULATED / not run: a single scripted 50-step end-to-end scenario
combining all of these with live WebSocket clients across instances was not
assembled as one artifact; its constituent guarantees are each proven above and
in the unit suite. Long-running soak was not run.
