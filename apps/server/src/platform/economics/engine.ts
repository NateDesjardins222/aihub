/**
 * Economics engine (M13.0) — the deterministic business simulation.
 *
 * A pure function of (authoritative products, assumptions, seed, customers,
 * horizon). It NEVER touches production data: no DB, no accounts, no payouts, no
 * email, no money movement. Given the same inputs it returns exactly the same
 * result, so every number is recomputable and auditable.
 *
 * It models the full customer economic lifecycle over TIME — arrival, purchase,
 * evaluation (pass/fail → reset/repurchase/churn), funded performance, the payout
 * lifecycle (eligible → approved → paid), affiliate commissions (created → matured →
 * paid, reversed on refund/chargeback), refunds and chargebacks (separate),
 * processing, operating costs, acquisition — and rolls it into revenue, payout
 * liability, a cash timeline and a treasury/reserve view.
 *
 * Money is integer micro-dollars. The 90/10 split reuses the real payout engine's
 * `splitAccounting`, so a simulated payout and a real one can never diverge.
 */
import { MICROS, splitAccounting } from '../payout-core.js';
import { mulberry32 } from '../economics-sim.js';
import { AUTHORITATIVE, ENGINE_VERSION, MODEL_VERSION, type Assumptions, type AuthoritativeProduct } from './config.js';

/** Days per modelled month (a calendar-agnostic 30-day bucket). */
export const DAYS_PER_MONTH = 30;
/** Settlement lag from a payout's approval (balance debit) to cash leaving. */
export const PAYOUT_SETTLE_DAYS = 3;

export interface SimInput {
  readonly products: AuthoritativeProduct[];
  readonly assumptions: Assumptions;
  readonly seed: number;
  readonly customers: number;
  readonly horizonDays: number;
}

export interface ProductResult {
  key: string;
  family: string;
  size: string;
  customers: number;
  purchases: number; // initial + repurchase evaluations
  resets: number;
  passes: number;
  fundedAccounts: number;
  payoutEvents: number;
  initialRevenueMicros: number;
  resetRevenueMicros: number;
  repurchaseRevenueMicros: number;
  grossSalesMicros: number;
  refundLossMicros: number;
  chargebackLossMicros: number;
  netRevenueMicros: number;
  traderPayoutMicros: number; // firm's payout expense (trader share)
  firmSplitMicros: number; // firm's retained 10%
  affiliateExpenseMicros: number;
  processingCostMicros: number;
  operatingAllocationMicros: number;
  acquisitionCostMicros: number;
  contributionMicros: number;
}

export interface CashPeriod {
  monthIndex: number;
  cashInMicros: number; // net purchase cash (after processing) minus refund/chargeback cash out
  purchaseCashMicros: number;
  processingCashMicros: number;
  traderPayoutCashMicros: number;
  affiliateCashMicros: number;
  refundCashMicros: number;
  chargebackCashMicros: number;
  operatingCashMicros: number;
  acquisitionCashMicros: number;
  netCashMicros: number; // in − out this period
  cumulativeCashMicros: number;
  reserveRequirementMicros: number;
  distributableCashMicros: number;
}

export interface Treasury {
  cashCollectedMicros: number; // cumulative net cash at horizon
  payoutLiabilityMicros: number; // approved, not yet paid
  affiliateLiabilityMicros: number; // matured/payable, not yet paid
  refundReserveMicros: number;
  operatingReserveMicros: number;
  taxPlaceholderMicros: number;
  safetyReserveMicros: number; // set by Monte-Carlo tail at analysis level; 0 here
  requiredReserveMicros: number;
  distributableCashMicros: number;
}

export interface PayoutLifecycle {
  eligibleAccounts: number;
  requestedEvents: number;
  approvedEvents: number;
  paidEvents: number;
  grossPayoutMicros: number;
  traderShareMicros: number; // firm payout expense
  firmShareMicros: number; // retained 10%
  paidTraderShareMicros: number; // cash actually out by horizon
  approvedUnpaidTraderShareMicros: number; // liability
}

export interface AffiliateLifecycle {
  attributedCustomers: number;
  commissionsCreated: number;
  grossCommissionMicros: number;
  maturedCommissionMicros: number;
  paidCommissionMicros: number;
  unpaidLiabilityMicros: number; // matured, not yet paid
  reversedCommissionMicros: number; // clawed back (refund/chargeback after available)
  canceledCommissionMicros: number; // reversed before ever available
  netCommissionExpenseMicros: number; // gross − canceled − reversed
  costPctOfAttributableRevenue: number;
}

export interface SimResult {
  engineVersion: string;
  modelVersion: string;
  seed: number;
  customers: number;
  horizonDays: number;
  months: number;

  // funnel counts
  purchases: number;
  resets: number;
  repurchases: number;
  passes: number;
  passRate: number;
  fundedAccounts: number;
  payoutRecipients: number;
  purchaseToPayoutPct: number;

  // revenue
  initialRevenueMicros: number;
  resetRevenueMicros: number;
  repurchaseRevenueMicros: number;
  grossSalesMicros: number;
  refundLossMicros: number;
  chargebackLossMicros: number;
  netRevenueMicros: number;
  refunds: number;
  chargebacks: number;

  payouts: PayoutLifecycle;
  affiliate: AffiliateLifecycle;

  // costs
  processingCostMicros: number;
  chargebackFeeMicros: number;
  operatingCostMicros: number;
  acquisitionCostMicros: number;

  // bottom line (modeled, not accounting)
  contributionMicros: number;
  contributionMargin: number;

  treasury: Treasury;
  timeline: CashPeriod[];
  byProduct: ProductResult[];
}

// ---- helpers ---------------------------------------------------------------

function clampInt(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Deterministic right-skewed payout draw in [min, cap]. */
function drawPayout(rng: () => number, minMicros: number, capMicros: number, meanFraction: number): number {
  if (capMicros <= minMicros) return capMicros;
  const u = (rng() + rng()) / 2;
  const frac = Math.min(1, Math.max(0, meanFraction * 0.6 + u * 0.8));
  return Math.round(minMicros + frac * (capMicros - minMicros));
}

const ARRIVAL_POW: Record<Assumptions['arrivalPattern'], number> = {
  FRONT_LOADED: 0.5,
  LINEAR: 1,
  RAMP: 2,
  SPIKE: 0.15,
};

/** Arrival day for customer i of N over the horizon, deterministic and monotonic. */
function arrivalDay(i: number, n: number, horizonDays: number, pattern: Assumptions['arrivalPattern']): number {
  const u = (i + 0.5) / n;
  const day = Math.floor(u ** ARRIVAL_POW[pattern] * horizonDays);
  return clampInt(day, 0, Math.max(0, horizonDays - 1));
}

function monthOf(day: number, months: number): number {
  return clampInt(Math.floor(day / DAYS_PER_MONTH), 0, months - 1);
}

interface Mutable {
  // per-period cash flows, indexed by month
  purchaseCash: number[];
  processingCash: number[];
  traderCash: number[];
  affiliateCash: number[];
  refundCash: number[];
  chargebackCash: number[];
  operatingVarCash: number[]; // per-customer + per-payout variable operating
  acquisitionCash: number[];
  grossSalesByMonth: number[];
}

function zeros(n: number): number[] {
  return new Array<number>(n).fill(0);
}

// ---------------------------------------------------------------------------
// The simulation.
// ---------------------------------------------------------------------------

export function simulate(input: SimInput): SimResult {
  const { assumptions: A, seed, customers, horizonDays } = input;
  const products = input.products;
  const months = Math.max(1, Math.ceil(horizonDays / DAYS_PER_MONTH));
  const rng = mulberry32(seed);

  // Purchase-mix weights (assumption; default 1 per product).
  const weights = products.map((p) => Math.max(0, A.productMixWeights[p.key] ?? 1));
  const totalWeight = weights.reduce((s, w) => s + w, 0) || 1;

  const per = new Map<string, ProductResult>();
  for (const p of products) {
    per.set(p.key, {
      key: p.key, family: p.familyName, size: p.size,
      customers: 0, purchases: 0, resets: 0, passes: 0, fundedAccounts: 0, payoutEvents: 0,
      initialRevenueMicros: 0, resetRevenueMicros: 0, repurchaseRevenueMicros: 0, grossSalesMicros: 0,
      refundLossMicros: 0, chargebackLossMicros: 0, netRevenueMicros: 0,
      traderPayoutMicros: 0, firmSplitMicros: 0, affiliateExpenseMicros: 0,
      processingCostMicros: 0, operatingAllocationMicros: 0, acquisitionCostMicros: 0, contributionMicros: 0,
    });
  }

  const m: Mutable = {
    purchaseCash: zeros(months), processingCash: zeros(months), traderCash: zeros(months),
    affiliateCash: zeros(months), refundCash: zeros(months), chargebackCash: zeros(months),
    operatingVarCash: zeros(months), acquisitionCash: zeros(months), grossSalesByMonth: zeros(months),
  };

  // Aggregates.
  let purchases = 0, resets = 0, repurchases = 0, passes = 0, funded = 0, payoutRecipients = 0;
  let initialRevenue = 0, resetRevenue = 0, repurchaseRevenue = 0;
  let refundLoss = 0, chargebackLoss = 0, refundCount = 0, chargebackCount = 0;
  let processingCost = 0, chargebackFeeTotal = 0, acquisitionCost = 0;

  const payouts: PayoutLifecycle = {
    eligibleAccounts: 0, requestedEvents: 0, approvedEvents: 0, paidEvents: 0,
    grossPayoutMicros: 0, traderShareMicros: 0, firmShareMicros: 0,
    paidTraderShareMicros: 0, approvedUnpaidTraderShareMicros: 0,
  };
  const aff: AffiliateLifecycle = {
    attributedCustomers: 0, commissionsCreated: 0, grossCommissionMicros: 0, maturedCommissionMicros: 0,
    paidCommissionMicros: 0, unpaidLiabilityMicros: 0, reversedCommissionMicros: 0, canceledCommissionMicros: 0,
    netCommissionExpenseMicros: 0, costPctOfAttributableRevenue: 0,
  };
  let attributableRevenue = 0;

  const pickProduct = (): number => {
    let r = rng() * totalWeight;
    for (let i = 0; i < products.length; i += 1) {
      r -= weights[i]!;
      if (r <= 0) return i;
    }
    return products.length - 1;
  };

  // A processed purchase: books revenue + processing + optional affiliate + refund/CB.
  const bookPurchase = (
    prod: AuthoritativeProduct, acc: ProductResult, day: number, kind: 'INITIAL' | 'RESET' | 'REPURCHASE',
    referred: boolean,
  ): void => {
    const gross = prod.priceMicros;
    const mo = monthOf(day, months);
    m.grossSalesByMonth[mo]! += gross;
    if (kind === 'INITIAL') { initialRevenue += gross; acc.initialRevenueMicros += gross; }
    else if (kind === 'RESET') { resetRevenue += gross; acc.resetRevenueMicros += gross; }
    else { repurchaseRevenue += gross; acc.repurchaseRevenueMicros += gross; }
    acc.grossSalesMicros += gross;

    // Processing fee (assumption): % + fixed, taken at purchase.
    const fee = Math.round(gross * A.processingPct) + A.processingFixedMicros;
    processingCost += fee; acc.processingCostMicros += fee;
    m.purchaseCash[mo]! += gross;
    m.processingCash[mo]! += fee;

    // Refund vs chargeback (separate, mutually exclusive per purchase).
    const roll = rng();
    let refunded = false, chargedBack = false, eventDay = day;
    if (roll < A.refundRate) {
      refunded = true; eventDay = day + A.refundLagDays;
      refundLoss += gross; acc.refundLossMicros += gross; refundCount += 1;
      if (eventDay < horizonDays) m.refundCash[monthOf(eventDay, months)]! += gross; // cash returned
    } else if (roll < A.refundRate + A.chargebackRate) {
      chargedBack = true; eventDay = day + A.chargebackLagDays;
      chargebackLoss += gross; acc.chargebackLossMicros += gross; chargebackCount += 1;
      chargebackFeeTotal += A.chargebackFeeMicros;
      if (eventDay < horizonDays) {
        const cbMo = monthOf(eventDay, months);
        m.chargebackCash[cbMo]! += gross + A.chargebackFeeMicros; // reverse + fee
      }
    }

    // Affiliate commission (authoritative rate; resets excluded unless opted in).
    const commissionable = referred && (kind !== 'RESET' || A.affiliateCommissionOnResets);
    if (commissionable) {
      attributableRevenue += gross;
      const commission = Math.floor((gross * Math.round(A.affiliateCommissionRate * 10000)) / 10000);
      if (commission > 0) {
        aff.commissionsCreated += 1;
        aff.grossCommissionMicros += commission;
        acc.affiliateExpenseMicros += commission; // provisional; adjusted for reversals below
        const matureDay = day + A.affiliateMaturityDays;
        const paidDay = matureDay + A.affiliatePayoutLagDays;
        const reversedByEvent = (refunded || chargedBack) && eventDay <= paidDay;
        if (reversedByEvent && eventDay < matureDay) {
          // Canceled before it was ever available — amount 0 net.
          aff.canceledCommissionMicros += commission;
          acc.affiliateExpenseMicros -= commission;
        } else if (reversedByEvent) {
          // Was available (matured/paid) then clawed back — net 0 but recorded.
          aff.reversedCommissionMicros += commission;
          acc.affiliateExpenseMicros -= commission;
          if (matureDay < horizonDays) aff.maturedCommissionMicros += commission;
        } else {
          if (matureDay < horizonDays) aff.maturedCommissionMicros += commission;
          if (paidDay < horizonDays) {
            aff.paidCommissionMicros += commission;
            m.affiliateCash[monthOf(paidDay, months)]! += commission;
          }
        }
      }
    }
  };

  for (let i = 0; i < customers; i += 1) {
    const day0 = arrivalDay(i, customers, horizonDays, A.arrivalPattern);
    const pIdx = pickProduct();
    const prod = products[pIdx]!;
    const acc = per.get(prod.key)!;
    acc.customers += 1;

    // Acquisition cost (paid channels; organic = 0).
    const cac = A.acquisitionModel === 'ORGANIC' ? 0
      : A.acquisitionModel === 'AFFILIATE' ? 0 // affiliate cost is the commission, not CAC
      : A.acquisitionModel === 'MIXED' ? Math.round(A.cacPerCustomerMicros * 0.5)
      : A.cacPerCustomerMicros;
    if (cac > 0) { acquisitionCost += cac; acc.acquisitionCostMicros += cac; m.acquisitionCash[monthOf(day0, months)]! += cac; }

    const referred = rng() < A.affiliatePenetration;
    if (referred) aff.attributedCustomers += 1;

    // ---- purchase → evaluation → (reset/repurchase/churn) → funded ----
    let repurchaseCount = 0;
    let attemptDay = day0;
    let firstAttempt = true;
    // Outer loop over fresh purchases (initial + repurchases).
    while (true) {
      bookPurchase(prod, acc, attemptDay, firstAttempt ? 'INITIAL' : 'REPURCHASE', referred);
      purchases += 1; acc.purchases += 1;
      if (!firstAttempt) repurchases += 1;
      firstAttempt = false;

      // Evaluate this account, with resets.
      let passed = rng() < A.passRate;
      let resetsUsed = 0;
      let evalDay = attemptDay;
      while (!passed && resetsUsed < A.maxResetsPerAccount && rng() < A.resetRateOnFail) {
        resetsUsed += 1; resets += 1; acc.resets += 1;
        evalDay += 14; // a reset re-runs shortly after
        bookPurchase(prod, acc, evalDay, 'RESET', referred);
        passed = rng() < A.passRate;
      }

      if (passed) {
        passes += 1; acc.passes += 1;
        funded += 1; acc.fundedAccounts += 1;
        if (runFunded(rng, A, prod, acc, evalDay, horizonDays, months, m, payouts)) payoutRecipients += 1;
        break; // a funded pass ends this customer's evaluation journey
      }

      // Failed and out of resets: maybe repurchase a fresh evaluation, else churn.
      if (repurchaseCount < A.maxRepurchases && rng() < A.repurchaseRateOnFail) {
        repurchaseCount += 1;
        attemptDay = evalDay + 21;
        if (attemptDay >= horizonDays) break;
        continue;
      }
      break;
    }
  }

  // ---- operating cost (fixed monthly + variable per customer/payout) ----
  const fixedMonthly = A.operatingCosts.reduce((s, c) => s + c.fixedMonthlyMicros, 0);
  const perCustomer = A.operatingCosts.reduce((s, c) => s + c.perCustomerMicros, 0);
  const perPayout = A.operatingCosts.reduce((s, c) => s + c.perPayoutMicros, 0);
  // Variable operating booked at arrival (per customer) and at payout (per payout)
  // is already the same month distribution as acquisition/trader cash; approximate
  // by spreading per-customer cost across arrival months and per-payout across paid
  // months proportionally to their counts. For the timeline we add fixed monthly to
  // every active month and variable in aggregate.
  const variableOperating = perCustomer * customers + perPayout * payouts.paidEvents;
  const fixedOperatingTotal = fixedMonthly * months;
  const operatingCost = variableOperating + fixedOperatingTotal;
  // Distribute operating across the timeline: fixed per month; variable per-customer
  // by arrival gross-sales share, per-payout by trader-cash share.
  for (let mo = 0; mo < months; mo += 1) m.operatingVarCash[mo]! += fixedMonthly;
  // per-customer variable ~ arrival distribution (gross sales proxy)
  const totalGross = m.grossSalesByMonth.reduce((s, v) => s + v, 0) || 1;
  const totalTraderCash = m.traderCash.reduce((s, v) => s + v, 0) || 1;
  for (let mo = 0; mo < months; mo += 1) {
    m.operatingVarCash[mo]! += Math.round((perCustomer * customers) * (m.grossSalesByMonth[mo]! / totalGross));
    m.operatingVarCash[mo]! += Math.round((perPayout * payouts.paidEvents) * (m.traderCash[mo]! / totalTraderCash));
  }

  // ---- affiliate liability + net expense ----
  aff.unpaidLiabilityMicros = Math.max(0, aff.maturedCommissionMicros - aff.paidCommissionMicros);
  aff.netCommissionExpenseMicros = aff.grossCommissionMicros - aff.canceledCommissionMicros - aff.reversedCommissionMicros;
  aff.costPctOfAttributableRevenue = attributableRevenue > 0 ? aff.netCommissionExpenseMicros / attributableRevenue : 0;

  // ---- revenue rollup ----
  const grossSales = initialRevenue + resetRevenue + repurchaseRevenue;
  const netRevenue = grossSales - refundLoss - chargebackLoss;

  // ---- contribution (modeled; firm 10% split retained in revenue, trader share is the expense) ----
  const contribution =
    netRevenue - payouts.traderShareMicros - aff.netCommissionExpenseMicros - processingCost -
    chargebackFeeTotal - operatingCost - acquisitionCost;

  // ---- build cash timeline + reserves ----
  const timeline = buildTimeline(m, months, A, payouts, aff, grossSales, operatingCost, contribution);
  const treasury = buildTreasury(timeline, A, payouts, aff, grossSales, operatingCost, months, contribution);

  // ---- per-product finish (operating allocation by gross-sales share; contribution) ----
  finalizeProducts(per, { operatingCost, fixedOperatingTotal, perCustomer, perPayout }, grossSales);

  return {
    engineVersion: ENGINE_VERSION, modelVersion: MODEL_VERSION, seed, customers, horizonDays, months,
    purchases, resets, repurchases, passes, passRate: purchases > 0 ? passes / purchases : 0,
    fundedAccounts: funded, payoutRecipients, purchaseToPayoutPct: purchases > 0 ? payoutRecipients / purchases : 0,
    initialRevenueMicros: initialRevenue, resetRevenueMicros: resetRevenue, repurchaseRevenueMicros: repurchaseRevenue,
    grossSalesMicros: grossSales, refundLossMicros: refundLoss, chargebackLossMicros: chargebackLoss,
    netRevenueMicros: netRevenue, refunds: refundCount, chargebacks: chargebackCount,
    payouts, affiliate: aff,
    processingCostMicros: processingCost, chargebackFeeMicros: chargebackFeeTotal,
    operatingCostMicros: operatingCost, acquisitionCostMicros: acquisitionCost,
    contributionMicros: contribution, contributionMargin: netRevenue > 0 ? contribution / netRevenue : 0,
    treasury, timeline, byProduct: [...per.values()],
  };
}

/** Run a funded account's payout lifecycle. Mutates accumulators. Returns true if
 *  the account took at least one payout (i.e. is a payout recipient). */
function runFunded(
  rng: () => number, A: Assumptions, prod: AuthoritativeProduct, acc: ProductResult,
  fundedDay: number, horizonDays: number, months: number, m: Mutable, payouts: PayoutLifecycle,
): boolean {
  if (rng() >= A.fundedSurvivalToPayout) return false; // churned before eligibility
  payouts.eligibleAccounts += 1;
  if (rng() >= A.firstPayoutProb) return false; // eligible but never takes a payout

  let took = false;
  let ordinal = 0;
  let takeAnother = true;
  while (takeAnother && ordinal < AUTHORITATIVE.maxPayoutCycles) {
    ordinal += 1;
    // SELECT consistency can delay (skip) an attempt without ending the account.
    if (prod.family === 'SELECT' && rng() < A.selectConsistencyBlockRate) {
      takeAnother = rng() < A.repeatPayoutProb;
      continue;
    }
    const approvalDay = fundedDay + A.firstPayoutLagDays + (ordinal - 1) * A.payoutIntervalDays;
    if (approvalDay >= horizonDays + DAYS_PER_MONTH) break; // beyond the near-term window we model
    const gross = drawPayout(rng, prod.minRequestMicros, prod.payoutCapMicros, A.avgPayoutFractionOfCap);
    const split = splitAccounting(gross, prod.profitSplitPercent);
    took = true;
    acc.payoutEvents += 1;
    payouts.requestedEvents += 1;
    payouts.grossPayoutMicros += gross;
    payouts.traderShareMicros += split.traderShareMicros;
    payouts.firmShareMicros += split.firmShareMicros;
    acc.traderPayoutMicros += split.traderShareMicros;
    acc.firmSplitMicros += split.firmShareMicros;

    const paidDay = approvalDay + PAYOUT_SETTLE_DAYS;
    if (approvalDay < horizonDays) {
      payouts.approvedEvents += 1;
      if (paidDay < horizonDays) {
        payouts.paidEvents += 1;
        payouts.paidTraderShareMicros += split.traderShareMicros;
        m.traderCash[monthOf(paidDay, months)]! += split.traderShareMicros;
      } else {
        payouts.approvedUnpaidTraderShareMicros += split.traderShareMicros; // liability
      }
    }
    // else: approved after horizon → future expected payout (informs reserve basis only)

    takeAnother = rng() < A.repeatPayoutProb;
  }
  return took;
}

function buildTimeline(
  m: Mutable, months: number, A: Assumptions, payouts: PayoutLifecycle, aff: AffiliateLifecycle,
  grossSales: number, operatingCost: number, contribution: number,
): CashPeriod[] {
  void payouts; void aff; void operatingCost;
  const periods: CashPeriod[] = [];
  let cumulative = 0;
  let cumulativeGross = 0;
  let cumulativePayoutLiab = 0;
  const avgMonthlyOperating = m.operatingVarCash.reduce((s, v) => s + v, 0) / months;
  for (let mo = 0; mo < months; mo += 1) {
    const purchaseCash = m.purchaseCash[mo]!;
    const processing = m.processingCash[mo]!;
    const trader = m.traderCash[mo]!;
    const affCash = m.affiliateCash[mo]!;
    const refund = m.refundCash[mo]!;
    const chargeback = m.chargebackCash[mo]!;
    const operating = m.operatingVarCash[mo]!;
    const acq = m.acquisitionCash[mo]!;
    const cashIn = purchaseCash - processing - refund - chargeback;
    const cashOut = trader + affCash + operating + acq;
    const net = cashIn - cashOut;
    cumulative += net;
    cumulativeGross += m.grossSalesByMonth[mo]!;
    // Approved-unpaid payout liability accrues toward the tail; approximate its
    // running level as proportional to cumulative trader cash share of the total.
    cumulativePayoutLiab = payouts.approvedUnpaidTraderShareMicros; // realized at horizon; shown flat
    const reserve = Math.round(
      A.payoutLiabilityCoverage * cumulativePayoutLiab +
      A.affiliateLiabilityCoverage * aff.unpaidLiabilityMicros * ((mo + 1) / months) +
      A.refundReservePct * cumulativeGross +
      A.operatingReserveMonths * avgMonthlyOperating +
      A.taxPlaceholderPct * Math.max(0, contribution) * ((mo + 1) / months),
    );
    periods.push({
      monthIndex: mo,
      cashInMicros: cashIn, purchaseCashMicros: purchaseCash, processingCashMicros: processing,
      traderPayoutCashMicros: trader, affiliateCashMicros: affCash, refundCashMicros: refund,
      chargebackCashMicros: chargeback, operatingCashMicros: operating, acquisitionCashMicros: acq,
      netCashMicros: net, cumulativeCashMicros: cumulative,
      reserveRequirementMicros: reserve, distributableCashMicros: cumulative - reserve,
    });
  }
  return periods;
}

function buildTreasury(
  timeline: CashPeriod[], A: Assumptions, payouts: PayoutLifecycle, aff: AffiliateLifecycle,
  grossSales: number, operatingCost: number, months: number, contribution: number,
): Treasury {
  const last = timeline[timeline.length - 1]!;
  const cashCollected = last.cumulativeCashMicros;
  const payoutLiability = payouts.approvedUnpaidTraderShareMicros;
  const affiliateLiability = aff.unpaidLiabilityMicros;
  const refundReserve = Math.round(A.refundReservePct * grossSales);
  const operatingReserve = Math.round(A.operatingReserveMonths * (operatingCost / months));
  const taxPlaceholder = Math.round(A.taxPlaceholderPct * Math.max(0, contribution));
  const safetyReserve = 0; // set by Monte-Carlo tail at analysis level
  const required = Math.round(
    A.payoutLiabilityCoverage * payoutLiability + A.affiliateLiabilityCoverage * affiliateLiability +
    refundReserve + operatingReserve + taxPlaceholder + safetyReserve,
  );
  return {
    cashCollectedMicros: cashCollected, payoutLiabilityMicros: payoutLiability,
    affiliateLiabilityMicros: affiliateLiability, refundReserveMicros: refundReserve,
    operatingReserveMicros: operatingReserve, taxPlaceholderMicros: taxPlaceholder,
    safetyReserveMicros: safetyReserve, requiredReserveMicros: required,
    distributableCashMicros: cashCollected - required,
  };
}

function finalizeProducts(
  per: Map<string, ProductResult>,
  cost: { operatingCost: number; fixedOperatingTotal: number; perCustomer: number; perPayout: number },
  grossSales: number,
): void {
  for (const p of per.values()) {
    p.netRevenueMicros = p.grossSalesMicros - p.refundLossMicros - p.chargebackLossMicros;
    // Allocate fixed operating by gross-sales share; variable operating by direct drivers.
    const share = grossSales > 0 ? p.grossSalesMicros / grossSales : 0;
    const variable = cost.perCustomer * p.customers + cost.perPayout * p.payoutEvents;
    p.operatingAllocationMicros = Math.round(cost.fixedOperatingTotal * share + variable);
    p.contributionMicros =
      p.netRevenueMicros - p.traderPayoutMicros - p.affiliateExpenseMicros - p.processingCostMicros -
      p.operatingAllocationMicros - p.acquisitionCostMicros;
  }
}

/** Convenience: micros → whole dollars number (for display/JSON only). */
export function toUsd(micros: number): number {
  return micros / MICROS;
}
