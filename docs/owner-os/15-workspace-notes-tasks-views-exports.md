# Owner OS — Operator Workspace: Notes, Tasks, Saved Views & Exports

Module: `ops-workspace.ts`
Routes: `/api/v1/admin/ops/notes...`, `/tasks...`, `/views...`, `/exports...`

## Internal notes

`addNote` / `listNotes` / `pinNote` keep `internal_notes` against any subject
(`customer`, `account`, etc.). Pinned notes sort first. Writing a note requires
`customers.notes.write`; reading requires the relevant `*.read`. Notes are an audit
trail of human context, never a place to store secrets.

## Ops tasks

`createTask` / `listTasks` / `updateTask` manage `ops_tasks` with priority
(LOW/NORMAL/HIGH/URGENT) and status (OPEN/IN_PROGRESS/WAITING/RESOLVED), optionally
tied to a subject and an assignee. Reading requires `tasks.read`; managing requires
`tasks.manage`. A resolved task drops out of the OPEN list.

## Saved views

`saveView` / `listViews` / `deleteView` persist an operator's filter set for a
scope (e.g. `customers`). Views are scoped to the owner and team: a PERSONAL view is
visible only to its owner, not to other operators.

## Exports (bounded)

`createExportJob` materializes a bounded CSV for a whitelisted `kind`
(`EXPORT_KINDS`) and records it in `export_jobs` with a row count and result
reference. `getExport` / `listExports` read them back. Exports are bounded (never an
unbounded dump), run under `exports.run`, and — because an export is data leaving
the console — the permission is an owner/ADMIN capability, not a SUPPORT default.
