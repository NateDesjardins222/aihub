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

/** Map an authoritative portal state to the highest reached stage index. */
export function lifecycleActiveIndex(portalState: string): number {
  switch (portalState) {
    case 'PENDING':
    case 'EVALUATION_ACTIVE':
      return 0;
    case 'EVALUATION_PASSED':
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
  return (
    <ol
      className={`htv2-life${failed ? ' is-failed' : ''}${compact ? ' is-compact' : ''}`}
      data-testid="htv2-lifecycle"
      aria-label="Account lifecycle"
      style={{ ['--htv2-life-n' as string]: String(stages.length) }}
    >
      {stages.map((label, i) => (
        <li
          key={label}
          className={`htv2-life-stage${i <= active ? ' is-done' : ''}${i === active ? ' is-at' : ''}`}
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
