/**
 * Portal V2 — Progress (Experience Layer Phase 2 rebuild).
 *
 * The customer's personal Happy Trader journey, re-ordered to the IA Nathan asked for
 * (§29–45): My Goals FIRST, then The Journey (a visual path), Where You Stand (the
 * authoritative career snapshot he likes), The Clubs (a connected progression), and
 * Accomplishments. The old "Current focus" duplication is gone — pinned goals simply
 * sort to the top of My Goals (one goal system).
 *
 * Strict product rules unchanged: everything rewards PROGRESS / ACCOMPLISHMENT /
 * PERSONAL GOALS, never more trading. Personal goals use REAL checkboxes that persist
 * server-side (optimistic, with rollback on failure — error never shows false
 * completion). TRACKED goals cannot be checked by hand; they complete only from
 * authoritative data and render progress toward their target. Presentation only.
 */
import { useMemo, useState, type JSX } from 'react';
import { V2Section, V2EmptyState, V2Button, V2StatStrip } from './primitives';
import { V2Journey, V2ProgressRing, usePrefersReducedMotion, type JourneyNode } from './experience';
import { formatMoney } from './format';
import './progress-page.css';

// ---- View model (mirrors apps/server/src/platform/progress.ts) --------------

export type GoalKind = 'MANUAL' | 'TRACKED';
export type GoalStatus = 'ACTIVE' | 'COMPLETED' | 'ARCHIVED';
export type GoalMetric = 'CUMULATIVE_PAYOUT_MICROS' | 'FUNDED_ACCOUNTS' | 'EVALUATIONS_PASSED';

export interface GoalView {
  id: string; title: string; note: string | null; kind: GoalKind; metric: GoalMetric | null;
  targetValue: number | null; currentValue: number | null; status: GoalStatus; pinned: boolean;
  completedAt: number | null; createdAt: number;
}

export type ClubKey = 'TENK_CLUB' | 'FIFTYK_CLUB' | 'HUNDREDK_CLUB';
export interface ClubView { key: ClubKey; thresholdMicros: number; achieved: boolean; achievedAt: number | null; physical: boolean }
export interface MilestoneView { id: string; type: string; at: number; meta: Record<string, unknown> | null }

export interface ProgressView {
  memberSinceMs: number | null;
  hero: {
    lifetimePaidTraderShareMicros: number; fundedAccounts: number; evaluationsPassed: number;
    achievementsEarned: number; currentClub: ClubKey | null;
    nextClub: { key: ClubKey; thresholdMicros: number; remainingMicros: number } | null;
  };
  clubs: ClubView[]; milestones: MilestoneView[]; goals: GoalView[]; achievementsPublic: boolean;
}

export interface GoalDraft { title: string; note: string | null; kind: GoalKind; metric: GoalMetric | null; targetValue: number | null }

/** Goal mutations resolve to a boolean so the optimistic checkbox can roll back. */
export interface ProgressActions {
  onCreateGoal: (draft: GoalDraft) => Promise<boolean> | void;
  onUpdateGoal: (id: string, patch: { title?: string; note?: string | null; targetValue?: number | null }) => Promise<boolean> | void;
  onCompleteGoal: (id: string) => Promise<boolean> | void;
  onArchiveGoal: (id: string) => Promise<boolean> | void;
  onTogglePin: (id: string, pinned: boolean) => Promise<boolean> | void;
  onOpenPayouts?: () => void;
  onAddAccount?: () => void;
  onOpenCertificates?: () => void;
}

// ---- Labels -----------------------------------------------------------------

const MILESTONE_LABEL: Record<string, string> = {
  FUNDED: 'Became a funded trader', FIRST_PAYOUT: 'First payout', PAID_5K: '$5,000 paid to you',
  PAID_10K: '$10,000 paid to you', PAID_25K: '$25,000 paid to you', FIVE_PAYOUT_CLUB: 'Five-payout club',
  ACCOUNT_COMPLETED: 'Completed a funded account', TENK_CLUB: '$10K Club', FIFTYK_CLUB: '$50K Club', HUNDREDK_CLUB: '$100K Club',
};
const milestoneLabel = (t: string): string => MILESTONE_LABEL[t] ?? t;
const CLUB_LABEL: Record<ClubKey, string> = { TENK_CLUB: '$10K Club', FIFTYK_CLUB: '$50K Club', HUNDREDK_CLUB: '$100K Club' };
const METRIC_LABEL: Record<GoalMetric, string> = { CUMULATIVE_PAYOUT_MICROS: 'Lifetime paid to you', FUNDED_ACCOUNTS: 'Funded accounts', EVALUATIONS_PASSED: 'Evaluations passed' };
const METRIC_IS_MONEY: Record<GoalMetric, boolean> = { CUMULATIVE_PAYOUT_MICROS: true, FUNDED_ACCOUNTS: false, EVALUATIONS_PASSED: false };

const money0 = (m: number): string => formatMoney(m, { maxFractionDigits: 0 });
const fmtDate = (ms: number): string => new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit' });
const fmtMonthYear = (ms: number): string => new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
function goalTargetText(g: Pick<GoalView, 'metric' | 'targetValue'>): string { return g.targetValue == null || !g.metric ? '' : METRIC_IS_MONEY[g.metric] ? money0(g.targetValue) : String(g.targetValue); }
function goalCurrentText(g: Pick<GoalView, 'metric' | 'currentValue'>): string { return g.currentValue == null || !g.metric ? '' : METRIC_IS_MONEY[g.metric] ? money0(g.currentValue) : String(g.currentValue); }
function goalPct(g: Pick<GoalView, 'targetValue' | 'currentValue'>): number { return !g.targetValue || g.currentValue == null ? 0 : Math.max(0, Math.min(1, g.currentValue / g.targetValue)); }

// ---- Page -------------------------------------------------------------------

export function V2ProgressPage({ view, actions }: { view: ProgressView; actions: ProgressActions }): JSX.Element {
  const [editing, setEditing] = useState<GoalView | null>(null);
  const [trackOpen, setTrackOpen] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);

  const activeGoals = useMemo(
    () => view.goals.filter((g) => g.status === 'ACTIVE').sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt),
    [view.goals],
  );
  const completedGoals = view.goals.filter((g) => g.status === 'COMPLETED');
  const pinnedCount = activeGoals.filter((g) => g.pinned).length;
  const canPinMore = pinnedCount < 3;

  const hasAnything =
    view.hero.lifetimePaidTraderShareMicros > 0 || view.hero.fundedAccounts > 0 ||
    view.hero.evaluationsPassed > 0 || view.goals.length > 0 || view.milestones.length > 0;

  return (
    <div className="htv2-page htv2-progress">
      <header className="htv2-page-head">
        <h1 className="ht-t-page-title">The journey</h1>
        <p className="ht-t-meta">
          {view.memberSinceMs ? `A Happy Trader since ${fmtMonthYear(view.memberSinceMs)}. ` : ''}
          Everything you’re working toward, everything you’ve accomplished — and what’s ahead.
        </p>
      </header>

      {/* 1 · MY GOALS — top of page, real checkboxes, pinned first. */}
      <V2Section
        title="My goals"
        actions={<button className="htv2-link ht-t-nav" onClick={() => setTrackOpen(true)} data-testid="htv2-progress-track-goal">Track a milestone →</button>}
      >
        <QuickAddGoal onCreate={(title) => actions.onCreateGoal({ title, note: null, kind: 'MANUAL', metric: null, targetValue: null })} />
        {activeGoals.length === 0 ? (
          <V2EmptyState
            title="No active goals yet"
            hint="Add a personal goal above — a milestone you're aiming for. Or track an authoritative target (like reaching the $100K Club) that completes on its own as you progress."
          />
        ) : (
          <ul className="htv2-goals" data-testid="htv2-progress-goals">
            {activeGoals.map((g) => (
              <GoalRow key={g.id} goal={g} actions={actions} canPinMore={canPinMore} onEdit={() => setEditing(g)} />
            ))}
          </ul>
        )}
        {completedGoals.length > 0 && (
          <div className="htv2-goals-completed">
            <button className="htv2-link ht-t-nav" onClick={() => setShowCompleted((v) => !v)} data-testid="htv2-progress-toggle-completed" aria-expanded={showCompleted}>
              {showCompleted ? 'Hide' : 'Show'} completed ({completedGoals.length})
            </button>
            {showCompleted && (
              <ul className="htv2-done" data-testid="htv2-progress-done">
                {completedGoals.map((g) => (
                  <li key={g.id} className="htv2-done-row">
                    <span className="htv2-check is-static" aria-hidden />
                    <span className="ht-t-body-sm">{g.title}</span>
                    {g.completedAt && <span className="ht-t-meta ht-num htv2-tone-muted">{fmtDate(g.completedAt)}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </V2Section>

      {/* 2 · THE JOURNEY — a visual path, past → now → ahead. */}
      {(view.milestones.length > 0 || view.memberSinceMs != null) && (
        <V2Section title="The journey">
          <V2Journey nodes={buildJourney(view)} />
        </V2Section>
      )}

      {/* 3 · WHERE YOU STAND — the authoritative career snapshot. */}
      {hasAnything && (
        <V2Section title="Where you stand">
          <WhereYouStand view={view} onOpenPayouts={actions.onOpenPayouts} />
        </V2Section>
      )}

      {/* 4 · THE CLUBS — a connected lifetime-payout progression. */}
      <V2Section title="The clubs" actions={actions.onOpenPayouts ? <button className="htv2-link ht-t-nav" onClick={actions.onOpenPayouts} data-testid="htv2-progress-payouts">Payouts →</button> : undefined}>
        <ClubProgression clubs={view.clubs} lifetimePaid={view.hero.lifetimePaidTraderShareMicros} />
      </V2Section>

      {/* 5 · ACCOMPLISHMENTS — milestones earned; deep vault is Certificates. */}
      {view.milestones.length > 0 && (
        <V2Section
          title="Accomplishments"
          actions={actions.onOpenCertificates ? <button className="htv2-link ht-t-nav" onClick={actions.onOpenCertificates} data-testid="htv2-progress-vault">Certificate vault →</button> : undefined}
        >
          <ul className="htv2-accomplish" data-testid="htv2-progress-accomplishments">
            {view.milestones.map((m) => (
              <li key={m.id} className="htv2-accomplish-row">
                <span className="htv2-accomplish-dot" aria-hidden />
                <span className="ht-t-body-sm">{milestoneLabel(m.type)}</span>
                <span className="ht-t-meta ht-num htv2-tone-muted">{fmtDate(m.at)}</span>
              </li>
            ))}
          </ul>
        </V2Section>
      )}

      {!hasAnything && (
        <V2EmptyState
          title="Your journey starts here"
          hint="As you pass evaluations, get funded and receive payouts, your milestones appear on this journey. Set a personal goal above to track what matters to you."
          action={actions.onAddAccount ? <V2Button variant="primary" size="sm" onClick={actions.onAddAccount}>Get started</V2Button> : undefined}
        />
      )}

      {editing && (
        <GoalDialog goal={editing} onClose={() => setEditing(null)}
          onCreate={() => setEditing(null)}
          onSave={(id, patch) => { void actions.onUpdateGoal(id, patch); setEditing(null); }} />
      )}
      {trackOpen && (
        <GoalDialog goal={null} forceTracked onClose={() => setTrackOpen(false)}
          onCreate={(d) => { void actions.onCreateGoal(d); setTrackOpen(false); }}
          onSave={() => setTrackOpen(false)} />
      )}
    </div>
  );
}

// ---- Journey construction ---------------------------------------------------

function buildJourney(view: ProgressView): JourneyNode[] {
  const nodes: JourneyNode[] = [];
  if (view.memberSinceMs != null) nodes.push({ id: 'start', state: 'past', when: fmtDate(view.memberSinceMs), label: 'Joined Happy Trader' });
  for (const m of [...view.milestones].sort((a, b) => a.at - b.at)) {
    nodes.push({ id: m.id, state: 'past', when: fmtDate(m.at), label: milestoneLabel(m.type) });
  }
  nodes.push({ id: 'now', state: 'now', when: 'Now', label: `${money0(view.hero.lifetimePaidTraderShareMicros)} paid to you` });
  if (view.hero.nextClub) {
    nodes.push({ id: 'next', state: 'future', when: 'Ahead', label: CLUB_LABEL[view.hero.nextClub.key], detail: `${money0(view.hero.nextClub.remainingMicros)} to go` });
  }
  return nodes;
}

// ---- Where you stand --------------------------------------------------------

function WhereYouStand({ view, onOpenPayouts }: { view: ProgressView; onOpenPayouts?: () => void }): JSX.Element {
  return (
    <div className="htv2-stand" data-testid="htv2-progress-stand">
      <button className="htv2-stand-lead htv2-aura htv2-aura-rose htv2-aura-on" onClick={onOpenPayouts} disabled={!onOpenPayouts} data-testid="htv2-progress-stand-lead">
        <span className="ht-t-label">Paid to you, lifetime</span>
        <span className="htv2-stand-value ht-t-display ht-num htv2-metal-rose">{money0(view.hero.lifetimePaidTraderShareMicros)}</span>
        {view.hero.currentClub && <span className="ht-t-meta">Member of the <strong>{CLUB_LABEL[view.hero.currentClub]}</strong></span>}
      </button>
      <V2StatStrip items={[
        { label: 'Funded accounts', value: String(view.hero.fundedAccounts) },
        { label: 'Evaluations passed', value: String(view.hero.evaluationsPassed) },
        { label: 'Milestones earned', value: String(view.hero.achievementsEarned) },
      ]} />
    </div>
  );
}

// ---- Clubs (connected progression) ------------------------------------------

function ClubProgression({ clubs, lifetimePaid }: { clubs: ClubView[]; lifetimePaid: number }): JSX.Element {
  const top = clubs.reduce((m, c) => Math.max(m, c.thresholdMicros), 0) || 1;
  const railPct = Math.max(0, Math.min(1, lifetimePaid / top));
  return (
    <div className="htv2-clubline" data-testid="htv2-progress-clubs">
      <div className="htv2-clubline-rail" aria-hidden><span className="htv2-clubline-fill" style={{ width: `${(railPct * 100).toFixed(1)}%` }} /></div>
      <div className="htv2-clubline-ticks">
        {clubs.map((c) => {
          const pct = Math.max(0, Math.min(1, lifetimePaid / c.thresholdMicros));
          return (
            <div key={c.key} className={`htv2-clubtick${c.achieved ? ' is-member' : ''}`} data-testid="htv2-club-card" data-club={c.key}>
              <div className="htv2-clubtick-head">
                <V2ProgressRing pct={pct} done={c.achieved} size={38} stroke={4} ariaLabel={`${CLUB_LABEL[c.key]} ${Math.round(pct * 100)}%`}>
                  <span className="ht-t-meta ht-num">{c.achieved ? '✓' : `${Math.round(pct * 100)}%`}</span>
                </V2ProgressRing>
                <span className={`htv2-clubtick-name ht-t-fin-sm${c.achieved ? ' htv2-metal-gold' : ''}`}>{CLUB_LABEL[c.key]}</span>
              </div>
              <span className="ht-t-meta htv2-tone-muted">
                {c.achieved && c.achievedAt ? `Reached ${fmtDate(c.achievedAt)}${c.physical ? ' · plaque' : ''}` : `${money0(lifetimePaid)} of ${money0(c.thresholdMicros)}`}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---- Quick add --------------------------------------------------------------

function QuickAddGoal({ onCreate }: { onCreate: (title: string) => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const ok = title.trim().length > 0 && title.trim().length <= 120;
  const submit = (): void => { if (!ok) return; onCreate(title.trim()); setTitle(''); setOpen(false); };
  if (!open) {
    return <button className="htv2-goal-add" onClick={() => setOpen(true)} data-testid="htv2-progress-add-goal"><span aria-hidden>+</span> Add a goal</button>;
  }
  return (
    <div className="htv2-goal-compose" data-testid="htv2-goal-compose">
      <input className="htv2-input" autoFocus value={title} maxLength={120} placeholder="What are you aiming for?"
        onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') { setOpen(false); setTitle(''); } }}
        data-testid="htv2-goal-quick-title" />
      <V2Button variant="primary" size="sm" disabled={!ok} onClick={submit} testId="htv2-goal-quick-save">Add</V2Button>
      <button className="htv2-link ht-t-nav" onClick={() => { setOpen(false); setTitle(''); }}>Cancel</button>
    </div>
  );
}

// ---- Goal row (with REAL persistent checkbox) -------------------------------

function GoalRow({ goal, actions, canPinMore, onEdit }: { goal: GoalView; actions: ProgressActions; canPinMore: boolean; onEdit: () => void }): JSX.Element {
  const reduced = usePrefersReducedMotion();
  const tracked = goal.kind === 'TRACKED';
  const pct = goalPct(goal);
  const [optimisticDone, setOptimisticDone] = useState(false);
  const [justDone, setJustDone] = useState(false);
  const [error, setError] = useState(false);

  const onToggle = async (): Promise<void> => {
    if (tracked) return; // tracked goals complete only from authoritative data (§33)
    setError(false);
    setOptimisticDone(true);           // optimistic check (§27)
    if (!reduced) setJustDone(true);
    const ok = await actions.onCompleteGoal(goal.id);
    if (ok === false) { setOptimisticDone(false); setJustDone(false); setError(true); } // rollback — never a false completion
    // on success the parent re-reads authoritative data and this row unmounts into Completed
  };

  return (
    <li className={`htv2-goal${justDone ? ' htv2-just-done' : ''}`} data-testid="htv2-goal-card">
      <input
        type="checkbox"
        className={`htv2-check${tracked ? ' is-tracked' : ''}`}
        checked={tracked ? false : optimisticDone}
        disabled={tracked}
        onChange={() => void onToggle()}
        aria-label={tracked ? `${goal.title} — completes automatically` : `Mark "${goal.title}" done`}
        data-testid={tracked ? 'htv2-goal-check-tracked' : 'htv2-goal-check'}
        title={tracked ? 'This goal completes automatically when you reach its target' : 'Mark done'}
      />
      <div className="htv2-goal-body">
        <div className="htv2-goal-head">
          <span className="htv2-goal-title ht-t-fin-sm">{goal.title}</span>
          <span className={`htv2-goal-kind ht-t-meta${tracked ? ' is-tracked' : ''}`}>{tracked ? 'Tracked' : 'Personal'}{goal.pinned ? ' · pinned' : ''}</span>
        </div>
        {goal.note && <p className="htv2-goal-note ht-t-meta">{goal.note}</p>}
        {tracked && goal.metric && (
          <div className="htv2-goal-track">
            <V2ProgressRing pct={pct} size={40} stroke={4} ariaLabel={`${Math.round(pct * 100)}% to target`}>
              <span className="ht-t-meta ht-num">{Math.round(pct * 100)}%</span>
            </V2ProgressRing>
            <span className="ht-t-meta htv2-tone-muted">{METRIC_LABEL[goal.metric]}: {goalCurrentText(goal)} of {goalTargetText(goal)}</span>
          </div>
        )}
        {error && <span className="htv2-goal-error ht-t-meta" role="alert">Couldn’t save — please try again.</span>}
        <div className="htv2-goal-actions">
          {goal.pinned ? (
            <button className="htv2-link ht-t-nav" onClick={() => void actions.onTogglePin(goal.id, false)} data-testid="htv2-goal-unpin">Unpin</button>
          ) : (
            <button className="htv2-link ht-t-nav" disabled={!canPinMore} onClick={() => void actions.onTogglePin(goal.id, true)} data-testid="htv2-goal-pin" title={canPinMore ? 'Pin to the top' : 'You can pin up to 3 goals'}>Pin</button>
          )}
          <button className="htv2-link ht-t-nav" onClick={onEdit} data-testid="htv2-goal-edit">Edit</button>
          <button className="htv2-link ht-t-nav htv2-tone-muted" onClick={() => void actions.onArchiveGoal(goal.id)} data-testid="htv2-goal-archive">Archive</button>
        </div>
      </div>
    </li>
  );
}

// ---- Goal dialog (edit; create tracked) -------------------------------------

function GoalDialog({ goal, forceTracked = false, onClose, onCreate, onSave }: {
  goal: GoalView | null; forceTracked?: boolean; onClose: () => void;
  onCreate: (draft: GoalDraft) => void; onSave: (id: string, patch: { title?: string; note?: string | null; targetValue?: number | null }) => void;
}): JSX.Element {
  const isEdit = goal != null;
  const [title, setTitle] = useState(goal?.title ?? '');
  const [note, setNote] = useState(goal?.note ?? '');
  const kind: GoalKind = isEdit ? goal!.kind : forceTracked ? 'TRACKED' : 'MANUAL';
  const [metric, setMetric] = useState<GoalMetric>((goal?.metric as GoalMetric) ?? 'CUMULATIVE_PAYOUT_MICROS');
  const activeMetric = isEdit ? (goal!.metric as GoalMetric | null) : metric;
  const isMoney = activeMetric ? METRIC_IS_MONEY[activeMetric] : false;
  const initialTarget = goal?.targetValue != null && goal.metric && METRIC_IS_MONEY[goal.metric] ? Math.round(goal.targetValue / 1_000_000) : goal?.targetValue ?? '';
  const [target, setTarget] = useState<string>(initialTarget === '' ? '' : String(initialTarget));

  const titleOk = title.trim().length > 0 && title.trim().length <= 120;
  const targetNum = Number(target);
  const isTracked = kind === 'TRACKED';
  const targetOk = !isTracked || (Number.isInteger(targetNum) && targetNum > 0);

  function submit(): void {
    if (!titleOk || !targetOk) return;
    if (isEdit && goal) {
      const patch: { title?: string; note?: string | null; targetValue?: number | null } = { title: title.trim(), note: note.trim() || null };
      if (goal.kind === 'TRACKED') patch.targetValue = goal.metric && METRIC_IS_MONEY[goal.metric] ? Math.round(targetNum) * 1_000_000 : Math.round(targetNum);
      onSave(goal.id, patch);
      return;
    }
    onCreate({ title: title.trim(), note: note.trim() || null, kind, metric: isTracked ? metric : null, targetValue: isTracked ? (isMoney ? Math.round(targetNum) * 1_000_000 : Math.round(targetNum)) : null });
  }

  return (
    <div className="htv2-certmodal-scrim" role="dialog" aria-modal="true" aria-label={isEdit ? 'Edit goal' : 'Track a milestone'} data-testid="htv2-goal-dialog" onClick={onClose}>
      <div className="htv2-goaldialog" onClick={(e) => e.stopPropagation()}>
        <header className="htv2-certmodal-head">
          <span className="ht-t-section">{isEdit ? 'Edit goal' : 'Track a milestone'}</span>
          <button className="htv2-certmodal-x" onClick={onClose} aria-label="Close">✕</button>
        </header>

        <label className="htv2-field">
          <span className="ht-t-label">Goal</span>
          <input className="htv2-input" value={title} maxLength={120} placeholder={isTracked ? 'e.g. Reach the $100K Club' : 'What are you aiming for?'} onChange={(e) => setTitle(e.target.value)} data-testid="htv2-goal-title" />
        </label>
        <label className="htv2-field">
          <span className="ht-t-label">Note <span className="htv2-tone-muted">(optional)</span></span>
          <textarea className="htv2-input" value={note} maxLength={600} rows={2} placeholder="Why this matters to you" onChange={(e) => setNote(e.target.value)} />
        </label>

        {isTracked && (
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
              <span className="ht-t-label">Target {isMoney ? '(US$)' : '(count)'}</span>
              <input className="htv2-input ht-num" inputMode="numeric" value={target} placeholder={isMoney ? '100000' : '1'} onChange={(e) => setTarget(e.target.value.replace(/[^0-9]/g, ''))} data-testid="htv2-goal-target" />
            </label>
            <span className="ht-t-meta htv2-tone-muted">A tracked goal completes automatically when your real figure reaches the target. It can’t be checked by hand.</span>
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
