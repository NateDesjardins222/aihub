/**
 * Release identity (Phase 11).
 *
 * A running server must be able to say which build it is, so a production incident
 * can be tied to an exact commit. The deploy pipeline sets `GIT_SHA` (or
 * `RELEASE_SHA`) in the environment; when neither is present (a local dev run) we
 * report `dev`. This is a NON-SECRET identifier — a commit hash and a boot time —
 * and is safe to expose on the health surface. It never contains a credential.
 */
const STARTED_AT = new Date().toISOString();

export interface ReleaseInfo {
  /** Deployed commit, or 'dev' when unset (local run). Never a secret. */
  readonly commit: string;
  /** Optional human release/tag label if the pipeline sets RELEASE_LABEL. */
  readonly label: string | null;
  /** Process start time (ISO), so uptime and "which boot" are knowable. */
  readonly startedAt: string;
}

export function releaseInfo(): ReleaseInfo {
  const commit =
    process.env['GIT_SHA'] ??
    process.env['RELEASE_SHA'] ??
    process.env['SOURCE_COMMIT'] ??
    'dev';
  const label = process.env['RELEASE_LABEL'] ?? null;
  return { commit, label, startedAt: STARTED_AT };
}
