/**
 * Contract rollover engine (M4-H).
 *
 * A read model over the deterministic contract calendar in `@atlas/instruments`.
 * Execution always references a SPECIFIC real contract; the chart's continuous
 * series is a separate, presentation-only concern (kept distinct here). This
 * engine answers, for a root at an instant:
 *
 *   - the front (active) contract
 *   - the next contract
 *   - the previous contract
 *   - the roll state (whether the roll window is open) and how close the roll is
 *
 * It never stitches prices for execution and never silently rolls an order onto
 * a later contract — it only reports identities and roll timing.
 */
import {
  getInstrument,
  isExpired,
  lastTradingDay,
  resolveActiveContract,
  type ActiveContract,
} from '@atlas/instruments';
import type { InstrumentSpec } from '@atlas/contracts';

export type RollPhase = 'STEADY' | 'ROLL_WINDOW' | 'EXPIRING';

export interface ContractView {
  readonly code: string;
  readonly display: string;
  readonly month: number;
  readonly year: number;
  readonly lastTradingDay: number;
  readonly rollDate: number;
  readonly expired: boolean;
}

export interface RollView {
  readonly root: string;
  readonly asOf: number;
  readonly front: ContractView;
  readonly next: ContractView;
  readonly previous: ContractView | null;
  readonly phase: RollPhase;
  /** ms until the front contract's roll date (negative if past). */
  readonly msToRoll: number;
  /** ms until the front contract's last trading day. */
  readonly msToExpiry: number;
}

function view(c: ActiveContract, asOfMs: number): ContractView {
  return {
    code: c.code,
    display: c.display,
    month: c.month,
    year: c.year,
    lastTradingDay: c.lastTradingDay,
    rollDate: c.rollDate,
    expired: isExpired(c, asOfMs),
  };
}

/** The contract cycle months for a spec, ascending, as used by the resolver. */
function cycleMonths(spec: InstrumentSpec): readonly number[] {
  const cycle = spec.rollRule.cycle;
  if (cycle.kind === 'QUARTERLY') return [3, 6, 9, 12];
  if (cycle.kind === 'MONTHLY') return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  return cycle.months;
}

const MONTH_CODES = ['F', 'G', 'H', 'J', 'K', 'M', 'N', 'Q', 'U', 'V', 'X', 'Z'];

/** Build the contract that is `step` cycle-slots away from a front contract. */
function relativeContract(spec: InstrumentSpec, front: ActiveContract, step: number): ActiveContract {
  const months = cycleMonths(spec);
  const idx = months.indexOf(front.month);
  if (idx === -1) {
    // Front month not on the cycle (shouldn't happen); return front unchanged.
    return front;
  }
  const total = idx + step;
  const wrapped = ((total % months.length) + months.length) % months.length;
  const yearShift = Math.floor(total / months.length);
  const month = months[wrapped]!;
  const year = front.year + yearShift;
  const ltd = lastTradingDay(spec, year, month).toMillis();
  const code = `${spec.root}${MONTH_CODES[month - 1]}${String(year).slice(-2)}`;
  const display = `${spec.root} ${new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-US', { month: 'short' }).toUpperCase()} ${String(year).slice(-2)}`;
  return {
    code,
    display,
    month,
    year,
    lastTradingDay: ltd,
    // rollDate of a relative contract is not needed by callers; approximate as ltd.
    rollDate: ltd,
  };
}

export class RolloverEngine {
  /** The full roll view for a root at an instant. Throws on an unknown root. */
  view(root: string, asOfMs: number): RollView {
    const spec = getInstrument(root);
    if (!spec) throw new Error(`Unknown instrument ${root}`);
    const front = resolveActiveContract(spec, asOfMs);
    const next = relativeContract(spec, front, 1);
    const prev = relativeContract(spec, front, -1);

    const msToRoll = front.rollDate - asOfMs;
    const msToExpiry = front.lastTradingDay - asOfMs;
    const phase: RollPhase = isExpired(front, asOfMs)
      ? 'EXPIRING'
      : msToRoll <= 0
        ? 'ROLL_WINDOW'
        : 'STEADY';

    return {
      root: spec.root,
      asOf: asOfMs,
      front: view(front, asOfMs),
      next: view(next, asOfMs),
      previous: view(prev, asOfMs),
      phase,
      msToRoll,
      msToExpiry,
    };
  }

  /** The specific front contract code at an instant, or null if unresolvable. */
  frontCode(root: string, asOfMs: number): string | null {
    try {
      return this.view(root, asOfMs).front.code;
    } catch {
      return null;
    }
  }
}

export const rolloverEngine = new RolloverEngine();
