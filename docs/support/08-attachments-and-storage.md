# 08 — Attachments & storage

Customers and staff can attach screenshots, receipts and logs. `support-attachments.ts`
makes that safe: strict validation, executable rejection, a pluggable storage seam,
and signed, time-limited downloads. There are never public predictable URLs, and
the storage secret is never exposed to a client.

## The storage seam

`StorageProvider` is a small interface — `configured()`, `put`, `get`, `remove` —
so a real object store drops in behind it without touching callers. The default,
`InProcessStorage`, keeps bytes in memory (suitable for dev/test). A deployment
swaps in an object-store implementation via `setSupportStorage(provider)`.
`supportStorageStatus()` reports the active provider name and whether it is
configured — this is exactly what System Doctor's `support_storage` probe surfaces
(doc 12), truthfully naming "in-process default" versus a real backend.

Bytes are addressed only by an opaque `storage_key` (`att_<random>`); the key is
never a customer-guessable path.

## Validation — `validateUpload`

Before anything is stored, `validateUpload(filename, contentType, sizeBytes, settings)`:

- sanitises the filename (strips path separators and unsafe characters, caps 255);
- **rejects dangerous extensions** — `exe, sh, bat, cmd, com, msi, dll, scr, js,
  mjs, cjs, jar, app, deb, rpm, ps1, vbs, php, py, rb, pl` (`UNSAFE_FILE`);
- **rejects dangerous content types** — executables and JavaScript media types
  (`UNSAFE_TYPE`);
- enforces the config allow-list (`allowedAttachmentTypes`, default: PNG, JPEG,
  GIF, WEBP, PDF, plain text) — anything else is `DISALLOWED_TYPE`;
- rejects empty files and anything over `maxAttachmentBytes` (default 10 MB,
  `FILE_TOO_LARGE`).

## Create & list

`createAttachment` validates, writes the bytes to the storage provider under a
fresh key, then inserts the `support_attachments` row and audits. Default
visibility follows the uploader: a **staff** upload defaults to `INTERNAL`, a
**customer** upload to `CUSTOMER` (staff may override). `scan_status` is set to
`CLEAN` on this path (the column also supports a `PENDING`/scan model).

`listAttachments(db, ticketId, { includeInternal })` applies the same visibility
projection as messages: the customer view (`includeInternal: false`) returns only
`visibility === 'CUSTOMER'` rows, so a customer never sees a staff-internal
attachment.

## Signed, time-limited downloads

Downloads are gated by an HMAC token, not by knowing the id:

- `signDownloadToken(attachmentId, ttlSeconds = 300)` returns `"<exp>.<hmac>"`,
  where the HMAC is over `attachmentId.exp` using the download secret
  (`SUPPORT_ATTACH_SECRET`, falling back to `JWT_SECRET`, then a dev default).
- `verifyDownloadToken(attachmentId, token)` checks the expiry and compares the
  HMAC with `timingSafeEqual` (constant-time). An expired or tampered token fails.

The secret lives only on the server and is never sent to a client — the client
only ever holds a short-lived opaque token.

## Authorization — `canAccessAttachment`

Even with a valid token, the reader must be authorized:

- staff (`isStaff: true`) may read any attachment;
- a customer may read an attachment **only** if it is `CUSTOMER`-visible **and**
  belongs to their own ticket; internal attachments are always refused to
  customers.

The routes combine both checks. The customer download route
(`GET /api/v1/support/attachments/:id/download`) requires a valid token *and*
passes `canAccessAttachment(..., isStaff: false)`. The staff route
(`GET /api/v1/admin/ops/support/attachments/:id/download`) requires
`support.attachments.read` and passes `isStaff: true`. This layering defends
against IDOR: guessing an id is not enough — you need a signed token and the
ownership/role to match.
