/**
 * Display formatting. These functions format values the SERVER computed; they
 * never derive a P&L, a balance or a drawdown of their own.
 */

export function formatMicros(micros: number, opts?: { sign?: boolean; decimals?: number }): string {
  const decimals = opts?.decimals ?? 2;
  const dollars = micros / 1_000_000;
  const sign = opts?.sign && dollars > 0 ? '+' : dollars < 0 ? '-' : '';
  const body = Math.abs(dollars).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return `${sign}$${body}`;
}

export function formatCompactMicros(micros: number): string {
  const dollars = Math.abs(micros) / 1_000_000;
  if (dollars >= 1_000_000) return `${micros < 0 ? '-' : ''}$${(dollars / 1_000_000).toFixed(2)}M`;
  if (dollars >= 10_000) return `${micros < 0 ? '-' : ''}$${(dollars / 1_000).toFixed(1)}K`;
  return formatMicros(micros);
}

export function formatPrice(price: number | null | undefined, precision: number): string {
  if (price === null || price === undefined || !Number.isFinite(price)) return '—';
  return price.toFixed(precision);
}

export function pnlClass(micros: number): string {
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
