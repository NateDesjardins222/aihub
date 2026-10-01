/**
 * Portal V2 — Progress & Achievements (Experience Layer Phase 1).
 *
 * The customer's personal Happy Trader journey. A calm, premium, FIRST-CLASS
 * surface — not a badge grid and not a casino. Its centrepiece is a journey
 * TIMELINE (past → now → future), fed only by authoritative server data; around
 * it sit a hero summary, the trader clubs ($10K/$50K/$100K cumulative PAID
 * trader-share), the customer's own personal goals, and their current focus.
 *
 * Product principle (strict): everything here rewards PROGRESS, ACCOMPLISHMENT,
 * OWNERSHIP, ANTICIPATION and PERSONAL GOALS — never additional trading activity.
 * There are no streaks, no "trade now to keep it alive", no pressure. A customer
 * with nothing sees a truthful, welcoming zero-state.
 *
 * Presentation only: it takes an already-projected ProgressView and reports goal
 * intents back through `actions`. It never computes money and never fabricates.
 */
import { useMemo, useState, type JSX } from 'react';
import { V2Section, V2EmptyState, V2Button } from './primitives';
import { formatMoney } from './format';
import './progress-page.css';

// ---- View model (mirrors apps/server/src/platform/progress.ts) --------------

export type GoalKind = 'MANUAL' | 'TRACKED';
export type GoalStatus = 'ACTIVE' | 'COMPLETED' | 'ARCHIVED';
export type GoalMetric = 'CUMULATIVE_PAYOUT_MICROS' | 'FUNDED_ACCOUNTS' | 'EVALUATIONS_PASSED';

export interface GoalView {
  id: string;
  title: string;
  note: string | null;
  kind: GoalKind;
  metric: GoalMetric | null;
  targetValue: number | null;
  currentValue: number | null;
  status: GoalStatus;
  pinned: boolean;
  completedAt: number | null;
  createdAt: number;
}

export type ClubKey = 'TENK_CLUB' | 'FIFTYK_CLUB' | 'HUNDREDK_CLUB';
export interface ClubView {
  key: ClubKey;
  thresholdMicros: number;
  achieved: boolean;
  achievedAt: number | null;
  physical: boolean;
}
export interface MilestoneView { id: string; type: string; at: number; meta: Record<string, unknown> | null }

export interface ProgressView {
  memberSinceMs: number | null;
  hero: {
    lifetimePaidTraderShareMicros: number;
    fundedAccounts: number;
    evaluationsPassed: number;
    achievementsEarned: number;
    currentClub: ClubKey | null;
    nextClub: { key: ClubKey; thresholdMicros: number; remainingMicros: number } | null;
  };
  clubs: ClubView[];
  milestones: MilestoneView[];
  goals: GoalView[];
  achievementsPublic: boolean;
}

export interface GoalDraft {
  title: string;
  note: string | null;
  kind: GoalKind;
  metric: GoalMetric | null;
  targetValue: number | null; // micros for money metric, a count otherwise
}

export interface ProgressActions {
  onCreateGoal: (draft: GoalDraft) => void;
  onUpdateGoal: (id: string, patch: { title?: string; note?: string | null; targetValue?: number | null }) => void;
  onCompleteGoal: (id: string) => void;
  onArchiveGoal: (id: string) => void;
  onTogglePin: (id: string, pinned: boolean) => void;
  onOpenPayouts?: () => void;
  onAddAccount?: () => void;
}

// ---- Labels (local; covers clubs that lib.achLabel does not) ----------------

const MILESTONE_LABEL: Record<string, string> = {
  FUNDED: 'Became a funded trader',
  FIRST_PAYOUT: 'First payout',
  PAID_5K: '$5,000 paid to you',
  PAID_10K: '$10,000 paid to you',
  PAID_25K: '$25,000 paid to you',
  FIVE_PAYOUT_CLUB: 'Five-payout club',
  ACCOUNT_COMPLETED: 'Completed a funded account',
  TENK_CLUB: '$10K Club',
  FIFTYK_CLUB: '$50K Club',
  HUNDREDK_CLUB: '$100K Club',
};
function milestoneLabel(t: string): string { return MILESTONE_LABEL[t] ?? t; }

const CLUB_LABEL: Record<ClubKey, string> = {
  TENK_CLUB: '$10K Club',
  FIFTYK_CLUB: '$50K Club',
  HUNDREDK_CLUB: '$100K Club',
};
const METRIC_LABEL: Record<GoalMetric, string> = {
  CUMULATIVE_PAYOUT_MICROS: 'Lifetime paid to you',
  FUNDED_ACCOUNTS: 'Funded accounts',
  EVALUATIONS_PASSED: 'Evaluations passed',
};
const METRIC_IS_MONEY: Record<GoalMetric, boolean> = {
  CUMULATIVE_PAYOUT_MICROS: true,
  FUNDED_ACCOUNTS: false,
  EVALUATIONS_PASSED: false,
};

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit' });
}
function fmtMonthYear(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
}
function goalTargetText(g: Pick<GoalView, 'metric' | 'targetValue'>): string {
  if (g.targetValue == null || !g.metric) return '';
  return METRIC_IS_MONEY[g.metric] ? formatMoney(g.targetValue, { maxFractionDigits: 0 }) : String(g.targetValue);
}
function goalCurrentText(g: Pick<GoalView, 'metric' | 'currentValue'>): string {
  if (g.currentValue == null || !g.metric) return '';
  return METRIC_IS_MONEY[g.metric] ? formatMoney(g.currentValue, { maxFractionDigits: 0 }) : String(g.currentValue);
}
function goalPct(g: Pick<GoalView, 'targetValue' | 'currentValue'>): number {
  if (!g.targetValue || g.currentValue == null) return 0;
  return Math.max(0, Math.min(1, g.currentValue / g.targetValue));
}

// ---- The page ---------------------------------------------------------------

export function V2ProgressPage({ view, actions }: { view: ProgressView; actions: ProgressActions }): JSX.Element {
  const [editing, setEditing] = useState<GoalView | null>(null);
  const [creating, setCreating] = useState(false);

  const activeGoals = view.goals.filter((g) => g.status === 'ACTIVE');
  const completedGoals = view.goals.filter((g) => g.status === 'COMPLETED');
  const pinned = activeGoals.filter((g) => g.pinned);
  const canPinMore = pinned.length < 3;

  const hasAnything =
    view.hero.lifetimePaidTraderShareMicros > 0 ||
    view.hero.fundedAccounts > 0 ||
    view.hero.evaluationsPassed > 0 ||
    view.goals.length > 0 ||
    view.milestones.length > 0;

  return (
    <div className="htv2-page htv2-progress">
      <header className="htv2-page-head htv2-page-head-row">
        <div>
          <h1 className="ht-t-page-title">Your journey</h1>
          <p className="ht-t-meta">
            {view.memberSinceMs ? `A Happy Trader since ${fmtMonthYear(view.memberSinceMs)}.` : 'Your progress, milestones and personal goals.'}
          </p>
        </div>
        <V2Button variant="secondary" size="sm" onClick={() => setCreating(true)} testId="htv2-progress-new-goal">Set a goal</V2Button>
      </header>

      {/* Hero summary — authoritative figures. The lifetime-paid value is the one
          focal metallic moment on the page (aura + champagne), used sparingly. */}
      <section className="htv2-prog-hero htv2-enter" data-testid="htv2-progress-hero">
        <div className="htv2-prog-hero-lead htv2-aura htv2-aura-on">
          <span className="ht-t-label">Paid to you, lifetime</span>
          <span className="htv2-prog-hero-value ht-t-display ht-num htv2-metal-champagne">
            {formatMoney(view.hero.lifetimePaidTraderShareMicros, { maxFractionDigits: 0 })}
          </span>
          {view.hero.currentClub && (
            <span className="htv2-prog-hero-club ht-t-meta">Member of the <strong>{CLUB_LABEL[view.hero.currentClub]}</strong></span>
          )}
        </div>
        <dl className="htv2-prog-hero-stats">
          <div><dt className="ht-t-label">Funded accounts</dt><dd className="ht-t-fin-md ht-num">{view.hero.fundedAccounts}</dd></div>
          <div><dt className="ht-t-label">Evaluations passed</dt><dd className="ht-t-fin-md ht-num">{view.hero.evaluationsPassed}</dd></div>
          <div><dt className="ht-t-label">Milestones earned</dt><dd className="ht-t-fin-md ht-num">{view.hero.achievementsEarned}</dd></div>
        </dl>
      </section>

      {!hasAnything && (
        <V2EmptyState
          title="Your journey starts here"
          hint="As you pass evaluations, get funded and receive payouts, your milestones appear on this timeline. You can also set personal goals to track what matters to you."
          action={actions.onAddAccount ? <V2Button variant="primary" size="sm" onClick={actions.onAddAccount}>Get started</V2Button> : undefined}
        />
      )}

      {/* Journey timeline — the centrepiece. Horizontal on desktop, vertical on
          mobile (CSS). Past milestones → now → the road ahead. */}
      {(view.milestones.length > 0 || view.memberSinceMs != null) && (
        <V2Section title="Timeline">
          <JourneyTimeline view={view} />
        </V2Section>
      )}

      {/* Trader clubs — cumulative PAID trader-share. Calm progress, never a slot machine. */}
      <V2Section title="Trader clubs" actions={view.hero.nextClub && actions.onOpenPayouts ? <button className="htv2-link ht-t-nav" onClick={actions.onOpenPayouts} data-testid="htv2-progress-payouts">Payouts →</button> : undefined}>
        <div className="htv2-prog-clubs" data-testid="htv2-progress-clubs">
          {view.clubs.map((c) => (
            <ClubCard key={c.key} club={c} lifetimePaid={view.hero.lifetimePaidTraderShareMicros} />
          ))}
        </div>
      </V2Section>

      {/* Current focus — the 1–3 goals the customer has pinned. */}
      {pinned.length > 0 && (
        <V2Section title="Current focus">
          <div className="htv2-prog-focus" data-testid="htv2-progress-focus">
            {pinned.map((g) => (
              <GoalCard key={g.id} goal={g} actions={actions} canPinMore={canPinMore} onEdit={() => setEditing(g)} focus />
            ))}
          </div>
        </V2Section>
      )}

      {/* Personal goals. */}
      <V2Section
        title="Personal goals"
        actions={<button className="htv2-link ht-t-nav" onClick={() => setCreating(true)} data-testid="htv2-progress-add-goal">New goal →</button>}
      >
        {activeGoals.length === 0 ? (
          <V2EmptyState
            title="No active goals"
            hint="Set a personal goal — a milestone you're aiming for, or a target that tracks automatically as you progress. Goals are yours; they're about what you want to accomplish."
            action={<V2Button variant="secondary" size="sm" onClick={() => setCreating(true)}>Set a goal</V2Button>}
          />
        ) : (
          <div className="htv2-prog-goals" data-testid="htv2-progress-goals">
            {activeGoals.map((g) => (
              <GoalCard key={g.id} goal={g} actions={actions} canPinMore={canPinMore} onEdit={() => setEditing(g)} />
            ))}
          </div>
        )}
      </V2Section>

      {completedGoals.length > 0 && (
        <V2Section title="Accomplished">
          <ul className="htv2-prog-done" data-testid="htv2-progress-done">
            {completedGoals.map((g) => (
              <li key={g.id} className="htv2-prog-done-row">
                <span className="htv2-prog-done-check" aria-hidden>✓</span>
                <span className="ht-t-body-sm">{g.title}</span>
                {g.completedAt && <span className="ht-t-meta ht-num">{fmtDate(g.completedAt)}</span>}
              </li>
            ))}
          </ul>
        </V2Section>
      )}

      {(creating || editing) && (
        <GoalDialog
          goal={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
          onCreate={(d) => { actions.onCreateGoal(d); setCreating(false); }}
          onSave={(id, patch) => { actions.onUpdateGoal(id, patch); setEditing(null); }}
        />
      )}
    </div>
  );
}

// ---- Timeline ---------------------------------------------------------------

function JourneyTimeline({ view }: { view: ProgressView }): JSX.Element {
  // Build chronological nodes: a start node, each earned milestone (ascending),
  // a "now" marker, then the single nearest future node (next club).
  const past = useMemo(() => {
    const nodes: Array<{ id: string; kind: 'start' | 'milestone'; label: string; at: number }> = [];
    if (view.memberSinceMs != null) nodes.push({ id: 'start', kind: 'start', label: 'Joined Happy Trader', at: view.memberSinceMs });
    for (const m of view.milestones) nodes.push({ id: m.id, kind: 'milestone', label: milestoneLabel(m.type), at: m.at });
    return nodes.sort((a, b) => a.at - b.at);
  }, [view.memberSinceMs, view.milestones]);

  const future = view.hero.nextClub;

  return (
    <div className="htv2-timeline" data-testid="htv2-progress-timeline">
      <ol className="htv2-timeline-track">
        {past.map((n, i) => (
          <li key={n.id} className={`htv2-timeline-node htv2-enter ${n.kind === 'start' ? 'is-start' : 'is-past'}`} style={{ ['--i' as string]: i }}>
            <span className="htv2-timeline-dot" aria-hidden />
            <span className="htv2-timeline-when ht-t-meta ht-num">{fmtDate(n.at)}</span>
            <span className="htv2-timeline-label ht-t-body-sm">{n.label}</span>
          </li>
        ))}
        <li className="htv2-timeline-node is-now htv2-enter" style={{ ['--i' as string]: past.length }}>
          <span className="htv2-timeline-dot" aria-hidden />
          <span className="htv2-timeline-when ht-t-label">Now</span>
          <span className="htv2-timeline-label ht-t-body-sm">
            {formatMoney(view.hero.lifetimePaidTraderShareMicros, { maxFractionDigits: 0 })} paid to you
          </span>
        </li>
        {future && (
          <li className="htv2-timeline-node is-future htv2-enter" style={{ ['--i' as string]: past.length + 1 }}>
            <span className="htv2-timeline-dot" aria-hidden />
            <span className="htv2-timeline-when ht-t-label">Ahead</span>
            <span className="htv2-timeline-label ht-t-body-sm">
              {CLUB_LABEL[future.key]} — {formatMoney(future.remainingMicros, { maxFractionDigits: 0 })} to go
            </span>
          </li>
        )}
      </ol>
    </div>
  );
}

// ---- Clubs ------------------------------------------------------------------

function ClubCard({ club, lifetimePaid }: { club: ClubView; lifetimePaid: number }): JSX.Element {
  const pct = Math.max(0, Math.min(1, lifetimePaid / club.thresholdMicros));
  const gold = club.achieved;
  return (
    <div className={`htv2-club-card htv2-lift${gold ? ' is-achieved htv2-aura htv2-aura-gold htv2-aura-on' : ''}`} data-testid="htv2-club-card" data-club={club.key}>
      <div className="htv2-club-head">
        <span className={`htv2-club-name ht-t-fin-md${gold ? ' htv2-metal-gold' : ''}`}>{CLUB_LABEL[club.key]}</span>
        {club.achieved ? (
          <span className="htv2-club-badge ht-t-meta" data-testid="htv2-club-achieved">
            Member{club.physical ? ' · plaque' : ''}
          </span>
        ) : (
          <span className="ht-t-meta htv2-tone-muted">{Math.round(pct * 100)}%</span>
        )}
      </div>
      <div className="htv2-club-bar" aria-hidden><span className="htv2-club-fill" style={{ width: `${(pct * 100).toFixed(1)}%` }} /></div>
      <span className="ht-t-meta htv2-tone-muted">
        {club.achieved && club.achievedAt
          ? `Reached ${fmtDate(club.achievedAt)}`
          : `${formatMoney(lifetimePaid, { maxFractionDigits: 0 })} of ${formatMoney(club.thresholdMicros, { maxFractionDigits: 0 })} paid`}
      </span>
    </div>
  );
}

// ---- Goal card --------------------------------------------------------------

function GoalCard({ goal, actions, canPinMore, onEdit, focus = false }: {
  goal: GoalView; actions: ProgressActions; canPinMore: boolean; onEdit: () => void; focus?: boolean;
}): JSX.Element {
  const tracked = goal.kind === 'TRACKED';
  const pct = goalPct(goal);
  return (
    <div className={`htv2-goal-card htv2-lift${focus ? ' is-focus' : ''}`} data-testid="htv2-goal-card">
      <div className="htv2-goal-head">
        <span className="htv2-goal-title ht-t-fin-sm">{goal.title}</span>
        <span className={`htv2-goal-kind ht-t-meta${tracked ? ' is-tracked' : ''}`}>{tracked ? 'Tracked' : 'Personal'}</span>
      </div>
      {goal.note && <p className="htv2-goal-note ht-t-meta">{goal.note}</p>}
      {tracked && goal.metric && (
        <>
          <div className="htv2-goal-bar" aria-hidden><span className="htv2-goal-fill" style={{ width: `${(pct * 100).toFixed(1)}%` }} /></div>
          <span className="ht-t-meta htv2-tone-muted">
            {METRIC_LABEL[goal.metric]}: {goalCurrentText(goal)} of {goalTargetText(goal)}
          </span>
        </>
      )}
      <div className="htv2-goal-actions">
        {goal.pinned ? (
          <button className="htv2-link ht-t-nav" onClick={() => actions.onTogglePin(goal.id, false)} data-testid="htv2-goal-unpin">Unpin</button>
        ) : (
          <button className="htv2-link ht-t-nav" disabled={!canPinMore} onClick={() => actions.onTogglePin(goal.id, true)} data-testid="htv2-goal-pin" title={canPinMore ? 'Pin to current focus' : 'You can pin up to 3 goals'}>Pin</button>
        )}
        <button className="htv2-link ht-t-nav" onClick={onEdit} data-testid="htv2-goal-edit">Edit</button>
        {!tracked && (
          <button className="htv2-link ht-t-nav" onClick={() => actions.onCompleteGoal(goal.id)} data-testid="htv2-goal-complete">Mark done</button>
        )}
        <button className="htv2-link ht-t-nav htv2-tone-muted" onClick={() => actions.onArchiveGoal(goal.id)} data-testid="htv2-goal-archive">Archive</button>
      </div>
    </div>
  );
}

// ---- Goal dialog (create / edit) --------------------------------------------

function GoalDialog({ goal, onClose, onCreate, onSave }: {
  goal: GoalView | null;
  onClose: () => void;
  onCreate: (draft: GoalDraft) => void;
  onSave: (id: string, patch: { title?: string; note?: string | null; targetValue?: number | null }) => void;
}): JSX.Element {
  const isEdit = goal != null;
  const [title, setTitle] = useState(goal?.title ?? '');
  const [note, setNote] = useState(goal?.note ?? '');
  const [kind, setKind] = useState<GoalKind>(goal?.kind ?? 'MANUAL');
  const [metric, setMetric] = useState<GoalMetric>((goal?.metric as GoalMetric) ?? 'CUMULATIVE_PAYOUT_MICROS');
  // Target shown in natural units: whole dollars for money metrics, a count otherwise.
  const initialTarget = goal?.targetValue != null && goal.metric && METRIC_IS_MONEY[goal.metric]
    ? Math.round(goal.targetValue / 1_000_000)
    : goal?.targetValue ?? '';
  const [target, setTarget] = useState<string>(initialTarget === '' ? '' : String(initialTarget));

  const metricIsMoney = METRIC_IS_MONEY[metric];
  const titleOk = title.trim().length > 0 && title.trim().length <= 120;
  const targetNum = Number(target);
  const targetOk = kind === 'MANUAL' || (Number.isInteger(targetNum) && targetNum > 0);

  function submit(): void {
    if (!titleOk || !targetOk) return;
    if (isEdit && goal) {
      // Kind/metric are immutable on edit; only editable fields go through.
      const patch: { title?: string; note?: string | null; targetValue?: number | null } = {
        title: title.trim(),
        note: note.trim() || null,
      };
      if (goal.kind === 'TRACKED') {
        patch.targetValue = goal.metric && METRIC_IS_MONEY[goal.metric] ? Math.round(targetNum) * 1_000_000 : Math.round(targetNum);
      }
      onSave(goal.id, patch);
      return;
    }
    const draft: GoalDraft = {
      title: title.trim(),
      note: note.trim() || null,
      kind,
      metric: kind === 'TRACKED' ? metric : null,
      targetValue: kind === 'TRACKED' ? (metricIsMoney ? Math.round(targetNum) * 1_000_000 : Math.round(targetNum)) : null,
    };
    onCreate(draft);
  }

  return (
    <div className="htv2-certmodal-scrim" role="dialog" aria-modal="true" aria-label={isEdit ? 'Edit goal' : 'Set a goal'} data-testid="htv2-goal-dialog" onClick={onClose}>
      <div className="htv2-goaldialog" onClick={(e) => e.stopPropagation()}>
        <header className="htv2-certmodal-head">
          <span className="ht-t-section">{isEdit ? 'Edit goal' : 'Set a goal'}</span>
          <button className="htv2-certmodal-x" onClick={onClose} aria-label="Close">✕</button>
        </header>

        <label className="htv2-field">
          <span className="ht-t-label">Goal</span>
          <input className="htv2-input" value={title} maxLength={120} placeholder="e.g. Reach the $10K Club" onChange={(e) => setTitle(e.target.value)} data-testid="htv2-goal-title" />
        </label>

        <label className="htv2-field">
          <span className="ht-t-label">Note <span className="htv2-tone-muted">(optional)</span></span>
          <textarea className="htv2-input" value={note} maxLength={600} rows={2} placeholder="Why this matters to you" onChange={(e) => setNote(e.target.value)} />
        </label>

        {!isEdit && (
          <div className="htv2-field">
            <span className="ht-t-label">Type</span>
            <div className="htv2-seg" role="tablist">
              <button role="tab" aria-selected={kind === 'MANUAL'} className={`htv2-seg-btn${kind === 'MANUAL' ? ' on' : ''}`} onClick={() => setKind('MANUAL')} data-testid="htv2-goal-kind-manual">Personal</button>
              <button role="tab" aria-selected={kind === 'TRACKED'} className={`htv2-seg-btn${kind === 'TRACKED' ? ' on' : ''}`} onClick={() => setKind('TRACKED')} data-testid="htv2-goal-kind-tracked">Tracked</button>
            </div>
            <span className="ht-t-meta htv2-tone-muted">
              {kind === 'MANUAL' ? 'A personal aim you mark done yourself.' : 'Completes automatically when your real progress reaches the target.'}
            </span>
          </div>
        )}

        {((!isEdit && kind === 'TRACKED') || (isEdit && goal?.kind === 'TRACKED')) && (
          <div className="htv2-goal-tracked-fields">
            {!isEdit && (
              <label className="htv2-field">
                <span className="ht-t-label">Track</span>
                <select className="htv2-input" value={metric} onChange={(e) => setMetric(e.target.value as GoalMetric)} data-testid="htv2-goal-metric">
                  <option value="CUMULATIVE_PAYOUT_MICROS">{METRIC_LABEL.CUMULATIVE_PAYOUT_MICROS}</option>
                  <option value="FUNDED_ACCOUNTS">{METRIC_LABEL.FUNDED_ACCOUNTS}</option>
                  <option value="EVALUATIONS_PASSED">{METRIC_LABEL.EVALUATIONS_PASSED}</option>
                </select>
              </label>
            )}
            <label className="htv2-field">
              <span className="ht-t-label">Target {(isEdit ? goal?.metric && METRIC_IS_MONEY[goal.metric] : metricIsMoney) ? '(US$)' : '(count)'}</span>
              <input className="htv2-input ht-num" inputMode="numeric" value={target} placeholder={(isEdit ? goal?.metric && METRIC_IS_MONEY[goal.metric] : metricIsMoney) ? '10000' : '1'} onChange={(e) => setTarget(e.target.value.replace(/[^0-9]/g, ''))} data-testid="htv2-goal-target" />
            </label>
          </div>
        )}

        <div className="htv2-certmodal-actions">
          <V2Button variant="primary" size="sm" disabled={!titleOk || !targetOk} onClick={submit} testId="htv2-goal-save">{isEdit ? 'Save' : 'Create goal'}</V2Button>
          <button className="htv2-btn htv2-btn-secondary htv2-btn-sm ht-t-button" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
