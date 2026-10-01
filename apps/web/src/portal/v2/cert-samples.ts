/**
 * DEV-REVIEW certificate sample artifacts.
 *
 * These PNGs are REAL output of the production certificate renderer
 * (`CanvasCertificateRenderer`, Milestone 6) — the same deterministic renderer, the same
 * approved template masters and fonts — captured via `scripts/render-golden-certs.mjs`
 * with golden sample values. They are the ACTUAL certificate artwork, not a CSS
 * re-creation. They exist ONLY so the dev review (which has no authenticated session)
 * can show the real artwork in the vault.
 *
 * Production never uses these: it fetches each customer's OWN rendered artifact from the
 * authenticated endpoint `GET /api/v1/portal/certificates/:id/image` (see
 * PORTAL_V2_CERTIFICATE_ARCHITECTURE.md). No production code path imports this module.
 */
import fundedTrader from './brand/certs/funded-trader.sample.png';
import payout from './brand/certs/payout.sample.png';
import accountCompleted from './brand/certs/account-completed.sample.png';
import tenkClub from './brand/certs/tenk-club.sample.png';
import fiftykClub from './brand/certs/fiftyk-club.sample.png';

/** Map an authoritative certificate `type` to its real rendered sample artwork. */
export const CERT_SAMPLE_BY_TYPE: Record<string, string> = {
  FUNDED_TRADER: fundedTrader,
  PAYOUT: payout,
  ACCOUNT_COMPLETED: accountCompleted,
  ACCOUNT_COMPLETION: accountCompleted,
  TENK_CLUB: tenkClub,
  FIFTYK_CLUB: fiftykClub,
};

export function sampleArtifactFor(type: string): string | null {
  return CERT_SAMPLE_BY_TYPE[type] ?? null;
}
