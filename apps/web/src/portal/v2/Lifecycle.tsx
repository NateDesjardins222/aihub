/**
 * V2Lifecycle — the account lifecycle path, overflow-proof by construction.
 *
 * Product Rebuild Phase 0 (STEP 17). The V1 lifecycle (`.pt-path`, a flex row
 * with fixed-width `::after` connectors) has an intrinsic width that can exceed
 * its parent, so the stages escaped the account card. V2 uses a CSS GRID of
 * `repeat(N, minmax(0, 1fr))`: every stage owns an equal fraction of the parent
 * and `minmax(0, …)` lets it shrink below its content, so the row can NEVER be
 * wider than its container. Connectors are drawn inside each cell (they add no
 * intrinsic width). No absolute positioning, no `overflow: hidden` band-aid.
 *
 * This is presentation-only; stage/active come from authoritative portal state.
 */
import type { JSX } from 'react';
import './Lifecycle.css';

export const LIFECYCLE_STAGES = ['Evaluation', 'Funded', 'Payouts', 'Completed'] as const;
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

/**
 * Map an authoritative portal state to the highest stage the account has FULLY
 * reached. EVALUATION_PASSED has completed Evaluation (index 0) but has NOT yet
 * reached Funded — its funded account is still being activated — so it sits at 0,
 * one short of FUNDED_ACTIVE. The passed→funded distinction is drawn by the
 * component: a passed account shows Funded as an *incoming* stage, never as reached.
 */
export function lifecycleActiveIndex(portalState: string): number {
  switch (portalState) {
    case 'PENDING':
    case 'EVALUATION_ACTIVE':
    case 'EVALUATION_PASSED':
      return 0;
    case 'FUNDED_ACTIVE':
      return 1;
    case 'COMPLETED_MAX_PAYOUTS':
      return 3;
    default:
      return -1; // FAILED / INACTIVE / ARCHIVED — no highlight
  }
}

export function V2Lifecycle({
  portalState,
  stages = LIFECYCLE_STAGES as readonly string[],
  compact = false,
}: {
  portalState: string;
  stages?: readonly string[];
  compact?: boolean;
}): JSX.Element {
  const active = lifecycleActiveIndex(portalState);
  const failed = portalState === 'FAILED';
  // A passed-but-not-yet-funded account has completed Evaluation and is entering
  // Funded. Its "current" stage is the NEXT one (Funded), shown as incoming — never
  // as reached — so it reads distinctly from a live FUNDED_ACTIVE account.
  const passed = portalState === 'EVALUATION_PASSED';
  const atIndex = passed ? active + 1 : active;
  return (
    <ol
      className={`htv2-life${failed ? ' is-failed' : ''}${passed ? ' is-transitioning' : ''}${compact ? ' is-compact' : ''}`}
      data-testid="htv2-lifecycle"
      aria-label="Account lifecycle"
      style={{ ['--htv2-life-n' as string]: String(stages.length) }}
    >
      {stages.map((label, i) => (
        <li
          key={label}
          className={`htv2-life-stage${i <= active ? ' is-done' : ''}${i === atIndex ? ' is-at' : ''}${passed && i === atIndex ? ' is-next' : ''}`}
          aria-current={i === atIndex ? 'step' : undefined}
        >
          <span className="htv2-life-track" aria-hidden>
            <span className="htv2-life-line htv2-life-line-l" />
            <span className="htv2-life-dot" />
            <span className="htv2-life-line htv2-life-line-r" />
          </span>
          <span className="htv2-life-label ht-t-meta">{label}</span>
        </li>
      ))}
    </ol>
  );
}
