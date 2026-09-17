/**
 * Display formatting. These functions format values the SERVER computed; they
 * never derive a P&L, a balance or a drawdown of their own.
 */

/**
 * Micro-dollars as money, and NULL as a dash.
 *
 * Null means the platform could not price something. A dash says that; a zero
 * would say "no profit and no loss", which is a different claim and not one
 * Atlas is entitled to make.
 */
export function formatMicros(
  micros: number | null,
  opts?: { sign?: boolean; decimals?: number },
): string {
  if (micros === null) return '—';
  const decimals = opts?.decimals ?? 2;
  const dollars = micros / 1_000_000;
  const sign = opts?.sign && dollars > 0 ? '+' : dollars < 0 ? '-' : '';
  const body = Math.abs(dollars).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return `${sign}$${body}`;
}

export function formatCompactMicros(micros: number | null): string {
  if (micros === null) return '—';
  const dollars = Math.abs(micros) / 1_000_000;
  if (dollars >= 1_000_000) return `${micros < 0 ? '-' : ''}$${(dollars / 1_000_000).toFixed(2)}M`;
  if (dollars >= 10_000) return `${micros < 0 ? '-' : ''}$${(dollars / 1_000).toFixed(1)}K`;
  return formatMicros(micros);
}

export function formatPrice(price: number | null | undefined, precision: number): string {
  if (price === null || price === undefined || !Number.isFinite(price)) return '—';
  return price.toFixed(precision);
}

export function pnlClass(micros: number | null): string {
  if (micros === null) return 'flat';
  if (micros > 0) return 'pos';
  if (micros < 0) return 'neg';
  return 'flat';
}

export function formatClock(epochMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone,
  }).format(epochMs);
}

export function formatDateTime(epochMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone,
  }).format(epochMs);
}
