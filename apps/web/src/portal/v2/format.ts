/**
 * HAPPY TRADER — Portal V2 financial formatting (Product Rebuild Phase 1, STEP 10).
 *
 * The ONE place V2 turns authoritative micro-dollar integers into display strings.
 * Pure and deterministic; no business rules, no rounding that changes truth — only
 * presentation. All money is server-authoritative integer micro-dollars (1e6 = $1).
 * Every value is meant to render in a `.ht-num` (tabular-nums) element.
 */

export const MICROS_PER_DOLLAR = 1_000_000;

/** Format micro-dollars as USD. `sign` adds a leading '+' for positives. */
export function formatMoney(
  micros: number | null | undefined,
  opts: { sign?: boolean; maxFractionDigits?: number } = {},
): string {
  if (micros == null || !Number.isFinite(micros)) return '—';
  const dollars = micros / MICROS_PER_DOLLAR;
  const negative = dollars < 0;
  const lead = negative ? '-' : opts.sign && dollars > 0 ? '+' : '';
  const abs = Math.abs(dollars).toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: opts.maxFractionDigits ?? 2,
  });
  return `${lead}$${abs}`;
}

/** Sign-tone for a signed value: positive / negative / muted (zero or nullish). */
export function moneyTone(micros: number | null | undefined): 'positive' | 'negative' | 'muted' {
  if (micros == null || !Number.isFinite(micros) || micros === 0) return 'muted';
  return micros > 0 ? 'positive' : 'negative';
}

/** A percentage 0..1 → "NN.N%" (or a whole-number form when integral). */
export function formatPercent(fraction: number | null | undefined, digits = 1): string {
  if (fraction == null || !Number.isFinite(fraction)) return '—';
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** Clamp any progress input to an integer-safe 0..100 for a bar width. */
export function clampPercent(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 100) return 100;
  return value;
}

/** Account-size label from a starting balance, e.g. 100000 → "100K", 50000 → "50K". */
export function accountSizeLabel(startingBalanceMicros: number | null | undefined): string {
  if (startingBalanceMicros == null || !Number.isFinite(startingBalanceMicros) || startingBalanceMicros <= 0) return '';
  const dollars = startingBalanceMicros / MICROS_PER_DOLLAR;
  if (dollars >= 1000 && dollars % 1000 === 0) return `${dollars / 1000}K`;
  return formatMoney(startingBalanceMicros).replace('$', '');
}

/** Masked account id from a public id: last 4, bullet-prefixed. */
export function maskAccountId(publicId: string | null | undefined): string {
  if (!publicId) return '••••';
  return `•••• ${publicId.slice(-4)}`;
}
