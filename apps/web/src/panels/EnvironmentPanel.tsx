import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { useSession, selectedAccount } from '../state/session';
import { useTrading } from '../trading/store';
import type { SimulationEnvironment } from '../trading/api';
import './EnvironmentPanel.css';

/**
 * Simulation environment settings.
 *
 * These decide how pessimistic the simulator is, which is the difference
 * between a platform that teaches and one that flatters. Each control states
 * what it costs the trader, because "slippage: 0" looks harmless until you
 * realise it means every fill is perfect.
 */
export function EnvironmentPanel(): JSX.Element {
  const account = useSession(selectedAccount);
  const environment = useTrading((s) => s.environment);
  const depthAwareAvailable = useTrading((s) => s.depthAwareAvailable);
  const setEnvironment = useTrading((s) => s.setEnvironment);
  const loadEnvironment = useTrading((s) => s.loadEnvironment);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadEnvironment();
  }, [loadEnvironment, account?.id]);

  const update = async (patch: Partial<SimulationEnvironment>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await setEnvironment(patch);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save settings.');
    } finally {
      setBusy(false);
    }
  };

  if (!environment) return <div className="env-empty">Loading environment…</div>;

  return (
    <div className="env-panel">
      <p className="env-intro">
        How the simulator fills your orders. Defaults are deliberately pessimistic — a
        simulator that flatters you teaches habits that lose money live.
      </p>

      <section className="env-section">
        <div className="label">Fill model</div>
        <div className="env-row">
          {(['SIMPLE', 'ADVANCED', 'DEPTH_AWARE'] as const).map((model) => (
            <button
              key={model}
              className={`chip ${environment.fillModel === model ? 'chip-on' : ''}`}
              disabled={busy || (model === 'DEPTH_AWARE' && !depthAwareAvailable)}
              title={
                model === 'DEPTH_AWARE' && !depthAwareAvailable
                  ? 'Needs a Level 2 feed. The development feed provides none.'
                  : undefined
              }
              onClick={() => void update({ fillModel: model })}
            >
              {model === 'DEPTH_AWARE' ? 'Depth' : model === 'SIMPLE' ? 'Simple' : 'Advanced'}
            </button>
          ))}
        </div>
        <p className="env-note">
          Simple fills at the touch with no friction. Advanced adds latency and slippage.
          Depth-aware consumes real book levels and requires a licensed feed.
        </p>
      </section>

      <section className="env-section">
        <div className="label">Friction</div>
        <Numeric
          id="env-latency"
          label="Latency"
          suffix="ms"
          value={environment.latencyMs}
          min={0}
          max={5000}
          step={50}
          disabled={busy}
          onCommit={(v) => void update({ latencyMs: v })}
        />
        <Numeric
          id="env-slip"
          label="Market slippage"
          suffix="ticks"
          value={environment.marketSlippageTicks}
          min={0}
          max={20}
          step={1}
          disabled={busy}
          onCommit={(v) => void update({ marketSlippageTicks: v })}
        />
        <Numeric
          id="env-stopslip"
          label="Stop slippage"
          suffix="ticks"
          value={environment.stopSlippageTicks}
          min={0}
          max={20}
          step={1}
          disabled={busy}
          onCommit={(v) => void update({ stopSlippageTicks: v })}
        />
      </section>

      <section className="env-section">
        <div className="label">Realism</div>
        <Toggle
          id="env-bar"
          label="Fill from bar extremes"
          checked={environment.useBarRange}
          disabled={busy}
          onChange={(v) => void update({ useBarRange: v })}
          note="The quote stream samples every few seconds and misses most of what trades. Off, a stop the market genuinely ran through may never fill."
        />
        <Toggle
          id="env-through"
          label="Require trade through a limit"
          checked={environment.requireThroughTradeForLimit}
          disabled={busy}
          onChange={(v) => void update({ requireThroughTradeForLimit: v })}
          note="A touch does not guarantee a fill: there may have been a queue ahead of you at that price."
        />
        <Toggle
          id="env-adverse"
          label="Resolve ambiguity against you"
          checked={environment.intrabarPolicy === 'ADVERSE_FIRST'}
          disabled={busy}
          onChange={(v) =>
            void update({ intrabarPolicy: v ? 'ADVERSE_FIRST' : 'OBSERVED_ONLY' })
          }
          note="When one bar contains both your stop and your target, the sequence is unknowable. On, the stop is taken."
        />
        <Toggle
          id="env-fees"
          label="Charge commission and fees"
          checked={environment.feesEnabled}
          disabled={busy}
          onChange={(v) => void update({ feesEnabled: v })}
        />
        <Numeric
          id="env-liquidity"
          label="Max contracts per fill"
          suffix="(blank = unlimited)"
          value={environment.maxContractsPerFill ?? 0}
          min={0}
          max={100}
          step={1}
          disabled={busy}
          onCommit={(v) => void update({ maxContractsPerFill: v <= 0 ? null : v })}
        />
        <p className="env-note">
          The liquidity cap is a crude stand-in for finite depth. Real size-dependent fills
          need book data this feed does not carry.
        </p>
      </section>

      {error ? <div className="env-error">{error}</div> : null}
    </div>
  );
}

function Toggle({
  id,
  label,
  checked,
  disabled,
  onChange,
  note,
}: {
  id: string;
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
  note?: string;
}): JSX.Element {
  return (
    <div className="env-toggle">
      <label htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>{label}</span>
      </label>
      {note ? <p className="env-note">{note}</p> : null}
    </div>
  );
}

function Numeric({
  id,
  label,
  suffix,
  value,
  min,
  max,
  step,
  disabled,
  onCommit,
}: {
  id: string;
  label: string;
  suffix: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  onCommit: (value: number) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  return (
    <div className="env-numeric">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="num"
        type="number"
        min={min}
        max={max}
        step={step}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const next = Number(draft);
          if (Number.isFinite(next) && next !== value) onCommit(next);
        }}
      />
      <span className="env-suffix">{suffix}</span>
    </div>
  );
}
