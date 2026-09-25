/**
 * Named stress scenarios (M13.0 §17). Each scenario is an explicit override set over
 * BASE — nothing hidden. These are SIMULATIONS, not forecasts. The assumptions of any
 * scenario can be inspected (they are just an `Assumptions` object).
 */
import { defaultAssumptions, type Assumptions } from './config.js';

export type ScenarioName =
  | 'BASE'
  | 'HIGH_PASS_RATE'
  | 'HIGH_PAYOUT_RATE'
  | 'LOW_RESET_RATE'
  | 'HIGH_REFUND_RATE'
  | 'HIGH_CHARGEBACK_RATE'
  | 'HIGH_AFFILIATE_PENETRATION'
  | 'HIGH_CAC'
  | 'VIRAL_GROWTH'
  | 'PAYOUT_STRESS'
  | 'COMBINED_DOWNSIDE';

export const SCENARIO_NAMES: ScenarioName[] = [
  'BASE', 'HIGH_PASS_RATE', 'HIGH_PAYOUT_RATE', 'LOW_RESET_RATE', 'HIGH_REFUND_RATE',
  'HIGH_CHARGEBACK_RATE', 'HIGH_AFFILIATE_PENETRATION', 'HIGH_CAC', 'VIRAL_GROWTH',
  'PAYOUT_STRESS', 'COMBINED_DOWNSIDE',
];

const M = 1_000_000;

/** Build the assumption set for a named scenario. */
export function scenario(name: ScenarioName): Assumptions {
  const a = defaultAssumptions();
  switch (name) {
    case 'BASE':
      return { ...a, label: 'BASE' };
    case 'HIGH_PASS_RATE':
      return { ...a, label: 'HIGH_PASS_RATE', passRate: Math.min(1, a.passRate * 2.5) };
    case 'HIGH_PAYOUT_RATE':
      return {
        ...a, label: 'HIGH_PAYOUT_RATE',
        firstPayoutProb: Math.min(1, a.firstPayoutProb * 1.6),
        repeatPayoutProb: Math.min(0.95, a.repeatPayoutProb * 1.6),
        avgPayoutFractionOfCap: Math.min(1, a.avgPayoutFractionOfCap * 1.4),
      };
    case 'LOW_RESET_RATE':
      return { ...a, label: 'LOW_RESET_RATE', resetRateOnFail: a.resetRateOnFail * 0.3, repurchaseRateOnFail: a.repurchaseRateOnFail * 0.3 };
    case 'HIGH_REFUND_RATE':
      return { ...a, label: 'HIGH_REFUND_RATE', refundRate: Math.min(1, a.refundRate * 4) };
    case 'HIGH_CHARGEBACK_RATE':
      return { ...a, label: 'HIGH_CHARGEBACK_RATE', chargebackRate: Math.min(1, a.chargebackRate * 5), chargebackFeeMicros: 25 * M };
    case 'HIGH_AFFILIATE_PENETRATION':
      return { ...a, label: 'HIGH_AFFILIATE_PENETRATION', affiliatePenetration: Math.min(1, a.affiliatePenetration * 2), affiliateCommissionRate: 0.2 };
    case 'HIGH_CAC':
      return { ...a, label: 'HIGH_CAC', acquisitionModel: 'PAID', cacPerCustomerMicros: a.cacPerCustomerMicros * 4 };
    case 'VIRAL_GROWTH':
      return { ...a, label: 'VIRAL_GROWTH', arrivalPattern: 'SPIKE', affiliatePenetration: Math.min(1, a.affiliatePenetration * 1.6) };
    case 'PAYOUT_STRESS':
      return {
        ...a, label: 'PAYOUT_STRESS',
        passRate: Math.min(1, a.passRate * 1.6),
        fundedSurvivalToPayout: Math.min(1, a.fundedSurvivalToPayout * 1.6),
        firstPayoutProb: Math.min(1, a.firstPayoutProb * 1.7),
        repeatPayoutProb: Math.min(0.95, a.repeatPayoutProb * 1.8),
        avgPayoutFractionOfCap: Math.min(1, 0.9),
        selectConsistencyBlockRate: a.selectConsistencyBlockRate * 0.4,
      };
    case 'COMBINED_DOWNSIDE':
      return {
        ...a, label: 'COMBINED_DOWNSIDE',
        passRate: Math.min(1, a.passRate * 1.5),
        fundedSurvivalToPayout: Math.min(1, a.fundedSurvivalToPayout * 1.5),
        firstPayoutProb: Math.min(1, a.firstPayoutProb * 1.6),
        repeatPayoutProb: Math.min(0.95, a.repeatPayoutProb * 1.7),
        avgPayoutFractionOfCap: 0.85,
        refundRate: Math.min(1, a.refundRate * 3),
        chargebackRate: Math.min(1, a.chargebackRate * 4),
        resetRateOnFail: a.resetRateOnFail * 0.5,
        repurchaseRateOnFail: a.repurchaseRateOnFail * 0.5,
        acquisitionModel: 'PAID',
        cacPerCustomerMicros: a.cacPerCustomerMicros * 3,
        affiliatePenetration: Math.min(1, a.affiliatePenetration * 1.5),
      };
  }
}
