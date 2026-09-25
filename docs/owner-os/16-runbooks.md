# Owner OS — Operational Runbooks

Concrete, step-by-step procedures for the owner and authorized staff. Every
procedure here is backed by a real, audited endpoint; none of them touches a raw
database field.

---

## Runbook 1 — Emergency halt (something is going wrong in production)

1. Open **Command Center**. Read `overall` and the Attention list.
2. Go to **Ops System → Kill switches**.
3. Reauthenticate (`KILL_SWITCH` step-up) when prompted.
4. Engage the narrowest switch that stops the harm:
   - runaway order flow → `DISABLE_NEW_ORDERS` (risk-reducing cancels stay live),
   - payout problem → `DISABLE_PAYOUT_SUBMISSION` or `DISABLE_NEW_PAYOUT_REQUESTS`,
   - checkout/provisioning problem → `DISABLE_NEW_PURCHASES` / `DISABLE_PROVISIONING`,
   - broad incident → `MAINTENANCE_MODE`.
5. Open an incident (Runbook 3) referencing the switch and reason.
6. When resolved, **release** the switch (another `KILL_SWITCH` step-up). Confirm
   the guarded operation works again.

---

## Runbook 2 — A payout looks wrong

1. **Search** the payout id (global search) → open its **money trace**.
2. Read the eligibility state + reason codes and the ledger entries. Do **not**
   guess; the engine's reason codes are authoritative.
3. If the money genuinely needs correcting, use an **append-only adjustment** on the
   account (Runbook 4) — never edit a balance.
4. If it is a data-integrity issue, run the **Integrity Center** (Runbook 5).

---

## Runbook 3 — Open / manage an incident

1. **Ops System → Incidents → New** (needs `system.incidents.manage`).
2. Provide a title, severity and a dedupe key (so repeat signals group into this
   one incident).
3. Walk the lifecycle: ACKNOWLEDGED → INVESTIGATING → IDENTIFIED → MONITORING →
   RESOLVED. Assign an owner; link affected objects.
4. Record a resolution on RESOLVED. If it recurs, reopen (RESOLVED → INVESTIGATING).

---

## Runbook 4 — Financial correction (append-only adjustment)

1. Open the account → **Adjustments**.
2. **Preview** the action first.
3. Choose an explicit reason code and write an explanation.
4. Reauthenticate (`FINANCIAL` step-up) and submit. The adjustment is appended and
   audited; it can never be edited or deleted. Verify the new observed net.

---

## Runbook 5 — Data integrity check

1. **Ops System → Data Integrity** → run checks.
2. Any `FAIL` names the invariant, the affected count and sample refs.
3. Integrity **detects**; it does not auto-repair. Open an incident, investigate the
   sample refs, and correct via the appropriate audited flow (adjustment, payout
   operation, enforcement action).
4. Re-run until green.

---

## Runbook 6 — Provisioning exception (paid but not provisioned)

1. **Command Center** Attention list → "paid purchase(s) awaiting provisioning", or
   **Accounts → Provisioning exceptions**.
2. Inspect the entitlement/order.
3. **Retry provisioning** (`accounts.provisioning.retry`). The retry is idempotent —
   safe to run more than once.

---

## Runbook 7 — Add a staff member

1. **Staff & Access → Invite** (needs `staff.manage` + `STAFF` step-up).
2. Choose the role; add per-user GRANT/DENY overrides for least privilege.
3. The invitee sets their own password via the invitation link; no password is ever
   set or seen by the inviter.
4. To offboard: suspend or disable (disable needs a `STAFF` step-up) and
   revoke-sessions (`security.manage`).

---

## Runbook 8 — Investigate a customer ("view as customer")

1. **Search** the customer → open **360**.
2. If you must see what they see, start a **READ_ONLY impersonation** with a reason
   (`customers.impersonate`). Dangerous customer actions are refused for the
   impersonated session.
3. End the impersonation when done. Start and end are both audited; the owner can
   terminate any active impersonation from the security overview.

---

## Runbook 9 — Reconciliation review

1. **Ops System → Reconciliation.** Read matched / mismatch / unknown per system.
2. For any open mismatch, drill into the objects and correct via the proper audited
   flow. The center surfaces mismatches; it never silently rewrites financial rows.
