# HUMAN GOLDEN PATH

**Happy Trader Funding — the short physical test only Nathan can pass (assign L5).** ~23 checks.
Run against a freshly-seeded local dev environment (see HUMAN_ACCEPTANCE_CHECKLIST.md §0). Simulation
only; no real money. Mark each **PASS / FAIL / NOT TESTED**. Claude has NOT marked any of these.

Logins (dev): owner `owner@atlasfutures.local` / `atlas-owner-2026`; trader
`demo@atlasfutures.local` / `atlas-demo-2026`.

| # | Step | Expected |
|---|---|---|
| 1 | Sign in as **owner** at `/portal` | Lands in the customer portal |
| 2 | Open the profile menu (top-right avatar) | An **Owner Console →** entry is visible |
| 3 | Click **Owner Console →** | Enters Owner OS ("ATLAS operations"), no denial |
| 4 | Sign out; sign in as **trader** at `/portal` | Lands in the portal |
| 5 | Open the profile menu | **No** Owner Console entry (and typing `/admin` still shows the denial) |
| 6 | Open an account (Accounts → a card) | Account detail with balance, rules, controls |
| 7 | Controls → set **Max trades/day = 1**, Save | Success shown only after save resolves |
| 8 | Refresh the page | The value is still **1** (persisted) |
| 9 | Click **Trade →** to open Atlas for that account | Terminal opens on the right account |
| 10 | Place **one** market trade | Fills; position + P&L update |
| 11 | Attempt a **second** opening trade | **Rejected** with a reason naming the personal limit |
| 12 | Close/flatten the position | Allowed (reducing is never blocked) |
| 13 | Inspect account balance / P&L in Atlas | Consistent with the trade just made |
| 14 | Return to the **portal**; view the same account | Balance / P&L match Atlas |
| 15 | As **owner** in Owner OS, find that customer/account | Same balance / status as the trader sees |
| 16 | Owner: place an **account hold** (enforcement) | Hold recorded; audited |
| 17 | As the trader in Atlas, attempt a **new** trade | **Blocked** (enforcement hold); closing still allowed |
| 18 | Owner: **release** the hold | Trading resumes for the trader |
| 19 | Owner OS → Ops System: **engage a kill switch** (reason + password step-up) | Engages; a CRITICAL alert appears; new orders blocked |
| 20 | Owner OS: **release** the kill switch | New orders allowed again |
| 21 | Atlas: place a bracket order (entry + SL + TP); let one side trigger | The opposite protective order **cancels** (OCO); no orphan order remains |
| 22 | Refresh Atlas and the portal; reconnect | Orders, positions, balance, risk settings, hold state all remain correct |
| 23 | Overall | The product behaves as **one** coherent business across Portal ↔ Atlas ↔ Owner OS |

**Reproducing the automated golden proof (optional):** the same max-trades=1 behavior (steps 7–12) is
proven deterministically through the real order path in `apps/server/src/trading/golden-max-trades.test.ts`.
The read-only **state probe** can show any account's authoritative state at any point:
`pnpm --filter @atlas/server tsx src/scripts/state-probe.ts demo@atlasfutures.local`.

> Human acceptance is **BLOCKED — HUMAN** until Nathan completes this. Automated + browser evidence
> takes each item to at most L4; only Nathan's physical run assigns **L5**.
