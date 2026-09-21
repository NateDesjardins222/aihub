# Cross-process events

## The problem

If instance A processes a fill but a trader's (or owner's) WebSocket is on
instance B, B must learn of the change.

## The mechanism

PostgreSQL `LISTEN`/`NOTIFY`. After the outbox worker commits a batch it issues
`NOTIFY atlas_account_changed, '<accountId>'` (`notifyAccountChanged`). Every
instance runs `listenAccountChanged`; on a notification it calls
`gateway.publishAccountState(accountId)`, which reads the account's current
authoritative valuation (correct on any instance, since it reads the shared
database) and re-publishes it to that instance's subscribers.

## Truth vs wake-up

The notification is a **transient wake-up, never truth**. If it is lost — a
listener was down, a payload dropped — the durable projection and outbox still
hold the state, and the next read or the next event converges. Nothing financial
lives in the notification.

## Redis

**Not used, and deliberately not introduced.** PostgreSQL LISTEN/NOTIFY already
delivers the wake-up, the transactional outbox already delivers durably, and
SKIP LOCKED already coordinates workers. Adding Redis would create a second
store that could disagree with the database. Redis would be justified only by a
demonstrated need PostgreSQL cannot meet (e.g. fan-out volume beyond what
NOTIFY sustains, or sub-millisecond cross-instance push at high rate); Atlas is
not there, and if it arrives, Redis must remain a cache/bus, never truth.

## Client consistency

The trader store applies a valuation frame only if its account is the one on
screen NOW (not merely the subscription's account), and only if it is not older
than the last applied frame (`at`), so a delayed or wrong-account frame can
neither overwrite the current account nor roll P&L backward.

## Proven

`platform/account-notify.test.ts`: a NOTIFY on one connection reaches a LISTEN
on another (the cross-process condition).
