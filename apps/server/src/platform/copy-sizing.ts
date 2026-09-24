/**
 * Copy sizing — pure, deterministic per-account quantity computation
 * (docs/copy-execution-semantics-v1.md §1–2). No DB, no float surprises: the
 * multiplier is carried in THOUSANDTHS (0.5 → 500) so every quantity is exact
 * integer math. The single rounding rule is floor() — conservative, never sizes
 * a follower above the leader's intent, never alternates. A computed zero is an
 * explicit SKIP with a reason, never a silent drop.
 */

export type SizingMode = 'SAME' | 'MULTIPLIER' | 'FIXED';

export interface FollowerSizing {
  readonly mode: SizingMode;
  /** MULTIPLIER: multiplier in thousandths (0.5 → 500). Defaults to 1000 (1.0x). */
  readonly multiplierMilli?: number | null;
  /** FIXED: the fixed contract quantity this follower attempts. */
  readonly fixedQty?: number | null;
}

export interface SizedQuantity {
  /** Whole contracts this follower will attempt. 0 means it will not participate. */
  readonly qty: number;
  /** Human, audit-grade explanation of how qty was derived (always set). */
  readonly note: string;
  /** True when qty is 0 and the follower will be SKIPPED (not an error). */
  readonly skipped: boolean;
}

function fmtMultiplier(milli: number): string {
  return (milli / 1000).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 3 });
}

/**
 * The follower quantity for a leader quantity `leaderQty` (whole contracts > 0).
 * Deterministic; floor rounding; explicit zero handling.
 */
export function computeFollowerQty(leaderQty: number, sizing: FollowerSizing): SizedQuantity {
  if (!Number.isInteger(leaderQty) || leaderQty <= 0) {
    return { qty: 0, note: `leader quantity ${leaderQty} is not a positive whole number`, skipped: true };
  }
  switch (sizing.mode) {
    case 'SAME':
      return { qty: leaderQty, note: `SAME size = ${leaderQty}`, skipped: false };
    case 'MULTIPLIER': {
      const milli = sizing.multiplierMilli ?? 1000;
      if (!Number.isInteger(milli) || milli <= 0) {
        return { qty: 0, note: `invalid multiplier (${milli}‰)`, skipped: true };
      }
      // Integer math: floor(leaderQty × milli / 1000).
      const qty = Math.floor((leaderQty * milli) / 1000);
      const label = `MULTIPLIER ${fmtMultiplier(milli)}× × ${leaderQty} = ${(leaderQty * milli) / 1000} → ${qty} contract(s)`;
      return qty <= 0
        ? { qty: 0, note: `${label} (rounds to 0 — skipped)`, skipped: true }
        : { qty, note: label, skipped: false };
    }
    case 'FIXED': {
      const fixed = sizing.fixedQty ?? 0;
      if (!Number.isInteger(fixed) || fixed < 0) {
        return { qty: 0, note: `invalid fixed quantity (${fixed})`, skipped: true };
      }
      return fixed <= 0
        ? { qty: 0, note: `FIXED ${fixed} (skipped)`, skipped: true }
        : { qty: fixed, note: `FIXED ${fixed}`, skipped: false };
    }
    default:
      return { qty: 0, note: `unknown sizing mode`, skipped: true };
  }
}

/** Validate a follower's sizing config at configuration time (not trade time). */
export function validateFollowerSizing(sizing: FollowerSizing): string | null {
  if (sizing.mode === 'MULTIPLIER') {
    const milli = sizing.multiplierMilli ?? 1000;
    if (!Number.isInteger(milli) || milli <= 0) return 'A multiplier must be a positive number.';
    if (milli > 100_000) return 'A multiplier may not exceed 100x.';
  }
  if (sizing.mode === 'FIXED') {
    const fixed = sizing.fixedQty ?? 0;
    if (!Number.isInteger(fixed) || fixed <= 0) return 'A fixed size must be a positive whole number of contracts.';
    if (fixed > 1000) return 'A fixed size may not exceed 1000 contracts.';
  }
  return null;
}
