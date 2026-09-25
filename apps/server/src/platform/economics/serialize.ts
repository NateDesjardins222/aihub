/**
 * Export an economics run to structured, portable formats (M13.0 §25): a JSON
 * bundle and CSV views for summary, product economics, the cash timeline and the
 * assumptions. Money is emitted in whole dollars (2dp) for spreadsheet friendliness;
 * the JSON bundle keeps the exact integer micros.
 */
import { MICROS } from '../payout-core.js';
import type { EconRunBundle } from './run.js';

const usd = (micros: number): string => (micros / MICROS).toFixed(2);

function csvEscape(v: string | number): string {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(header: readonly string[], rows: readonly (string | number)[][]): string {
  return [header.join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join('\n');
}

/** Headline summary (one row of key figures). */
export function summaryCsv(b: EconRunBundle): string {
  const r = b.result;
  const header = [
    'scenario', 'seed', 'customers', 'horizonDays', 'purchases', 'resets', 'passes', 'fundedAccounts',
    'payoutRecipients', 'grossSalesUsd', 'netRevenueUsd', 'refundLossUsd', 'chargebackLossUsd',
    'traderPayoutUsd', 'affiliateExpenseUsd', 'processingUsd', 'operatingUsd', 'acquisitionUsd',
    'contributionUsd', 'contributionMarginPct', 'requiredReserveUsd', 'distributableCashUsd',
  ];
  const row: (string | number)[] = [
    b.scenario, b.seed, b.customers, b.horizonDays, r.purchases, r.resets, r.passes, r.fundedAccounts,
    r.payoutRecipients, usd(r.grossSalesMicros), usd(r.netRevenueMicros), usd(r.refundLossMicros), usd(r.chargebackLossMicros),
    usd(r.payouts.traderShareMicros), usd(r.affiliate.netCommissionExpenseMicros), usd(r.processingCostMicros),
    usd(r.operatingCostMicros), usd(r.acquisitionCostMicros), usd(r.contributionMicros), (r.contributionMargin * 100).toFixed(2),
    usd(r.treasury.requiredReserveMicros), usd(r.treasury.distributableCashMicros),
  ];
  return toCsv(header, [row]);
}

/** Product-economics table (one row per product). */
export function productCsv(b: EconRunBundle): string {
  const header = [
    'product', 'family', 'size', 'customers', 'purchases', 'resets', 'passes', 'funded', 'payoutEvents',
    'grossSalesUsd', 'totalRevenueUsd', 'payoutCostUsd', 'affiliateCostUsd', 'processingUsd',
    'refundLossUsd', 'chargebackLossUsd', 'operatingAllocUsd', 'acquisitionUsd', 'contributionUsd', 'contributionPerCustomerUsd',
  ];
  const rows = b.result.byProduct.map((p) => [
    p.key, p.family, p.size, p.customers, p.purchases, p.resets, p.passes, p.fundedAccounts, p.payoutEvents,
    usd(p.grossSalesMicros), usd(p.netRevenueMicros), usd(p.traderPayoutMicros), usd(p.affiliateExpenseMicros),
    usd(p.processingCostMicros), usd(p.refundLossMicros), usd(p.chargebackLossMicros), usd(p.operatingAllocationMicros),
    usd(p.acquisitionCostMicros), usd(p.contributionMicros), usd(p.customers > 0 ? Math.round(p.contributionMicros / p.customers) : 0),
  ]);
  return toCsv(header, rows);
}

/** The cash timeline (one row per modelled month). */
export function timelineCsv(b: EconRunBundle): string {
  const header = [
    'month', 'cashInUsd', 'traderPayoutUsd', 'affiliateUsd', 'refundUsd', 'chargebackUsd',
    'operatingUsd', 'acquisitionUsd', 'netCashUsd', 'cumulativeCashUsd', 'reserveRequirementUsd', 'distributableCashUsd',
  ];
  const rows = b.result.timeline.map((t) => [
    t.monthIndex + 1, usd(t.cashInMicros), usd(t.traderPayoutCashMicros), usd(t.affiliateCashMicros),
    usd(t.refundCashMicros), usd(t.chargebackCashMicros), usd(t.operatingCashMicros), usd(t.acquisitionCashMicros),
    usd(t.netCashMicros), usd(t.cumulativeCashMicros), usd(t.reserveRequirementMicros), usd(t.distributableCashMicros),
  ]);
  return toCsv(header, rows);
}

/** The assumptions, flattened to key/value rows so a run's inputs are portable. */
export function assumptionsCsv(b: EconRunBundle): string {
  const a = b.assumptions;
  const rows: (string | number)[][] = [];
  for (const [k, v] of Object.entries(a)) {
    if (k === 'operatingCosts') {
      for (const line of a.operatingCosts) {
        rows.push([`operating:${line.label}:fixedMonthlyUsd`, usd(line.fixedMonthlyMicros)]);
        rows.push([`operating:${line.label}:perCustomerUsd`, usd(line.perCustomerMicros)]);
        rows.push([`operating:${line.label}:perPayoutUsd`, usd(line.perPayoutMicros)]);
      }
    } else if (k === 'productMixWeights') {
      for (const [key, w] of Object.entries(a.productMixWeights)) rows.push([`mix:${key}`, w]);
    } else if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') {
      rows.push([k, String(v)]);
    }
  }
  return toCsv(['key', 'value'], rows);
}

/** The full run as a JSON string (exact micros preserved). */
export function bundleJson(b: EconRunBundle): string {
  return JSON.stringify(b, null, 2);
}
