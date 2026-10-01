/**
 * Metric display helpers — the honest rendering of a count that might be loading,
 * loaded, or failed to load.
 *
 * The rule this encodes (customer-system hardening §4B / CPI-2): a failed fetch is
 * NOT a zero. A funded trader whose payout list fails to load must never be shown
 * "0 payouts" as though it were an authoritative figure. The unknown value is a
 * dash; a real zero is "0", and the two are never collapsed.
 */

/**
 * Render a count metric.
 *
 * - error  → "—" (unknown; the fetch failed and we will not invent a number)
 * - null   → "—" (still loading)
 * - number → the number, INCLUDING a legitimate 0
 */
export function countBadge(value: number | null, error: boolean): string {
  if (error) return '—';
  if (value === null) return '—';
  return String(value);
}

/** Whether a count metric should render as an error (unknown), not as data. */
export function isCountError(error: boolean): boolean {
  return error;
}
