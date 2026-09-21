# Failure recovery

The question is never "did Atlas avoid crashing" but "did it recover to the
correct financial state". PostgreSQL is the only source of financial truth;
every other component is rebuildable from it.

| Failure | Behaviour | Proven by |
| --- | --- | --- |
| Financial tx commits, process dies before delivery | The outbox row committed with the mutation; a new worker finds and delivers it | outbox is transactional (enqueue in the mutation tx); multiprocess harness |
| Worker claims a batch, dies mid-processing | Its claiming transaction rolls back; rows unlock (SKIP LOCKED); another worker reclaims | multiprocess harness case [2], real SIGKILL |
| Projection update done, worker dies before marking | Handler + delivery mark are one transaction, so this window does not exist; a redelivery is harmless (idempotent recompute) | outbox design; projection-outbox tests |
| Projection corrupted | Reconciliation detects the drift | projection-outbox tests |
| Projection deleted | `rebuildAllProjections` restores it from authority, touching no financial truth | projection-outbox tests; scale run (0 drift after rebuild) |
| Redis down | N/A — Redis is not used; no financial truth depends on it | cross-process-events.md |
| WebSocket server dies | Financial truth unaffected; a reconnecting client gets a fresh snapshot; another instance re-publishes on NOTIFY | gateway snapshot-on-subscribe; cross-process fan-out |

Not run this milestone as scripted scenarios: a full API-process kill with a
live trader failover, and a whole-application-layer restart with post-restart
state verification, were not assembled end to end. The durable-truth design and
the per-mechanism proofs above cover their guarantees; the combined scripted run
is deferred and named here rather than implied.
