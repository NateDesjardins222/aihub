/**
 * The internal economics simulator.
 *
 * A synthetic what-if tool: it never touches production trader/account data.
 * The owner picks a scenario and scale, runs it server-side (seeded and
 * reproducible), and reads the outputs — headline economics, per-product/size
 * breakdown, single-lever sensitivity, a seeded Monte Carlo distribution, the
 * payout-cap experiment, and an illustrative reserve. Every assumption used is
 * shown; nothing is buried. This is a planning aid, not accounting.
 */
import { useState, type JSX } from 'react';
import { adminApi } from '../api';
import { Money, Panel, Stat } from '../shared';
import type { EconResult, EconomicsRun } from '../types';

const SCENARIOS = ['BASE', 'GOOD_FOR_FIRM', 'GOOD_FOR_TRADER', 'HIGH_PASS_RATE', 'HIGH_PAYOUT_RATE', 'HIGH_REPEAT_PAYOUT', 'HIGH_CAC', 'HIGH_FRAUD', 'DAILY_PAYOUT_STRESS', 'SELECT_HIGH_SKILL'];
const pctOf = (v: number) => `${(v * 100).toFixed(1)}%`;

export function AdminEconomicsPage(): JSX.Element {
  const [scenario, setScenario] = useState('BASE');
  const [purchases, setPurchases] = useState(100_000);
  const [seed, setSeed] = useState(2026);
  const [trials, setTrials] = useState(40);
  const [run, setRun] = useState<EconomicsRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      setRun(await adminApi.economicsRun({ scenario, seed, purchases, trials }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="adm-page">
      <Panel title="Economics simulator (synthetic — never production data)">
        <div className="adm-inline-actions" style={{ flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
          <label>Scenario<br /><select value={scenario} onChange={(e) => setScenario(e.target.value)} data-testid="econ-scenario">{SCENARIOS.map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
          <label>Purchases<br /><select value={purchases} onChange={(e) => setPurchases(Number(e.target.value))} data-testid="econ-purchases">{[10_000, 100_000, 1_000_000].map((n) => <option key={n} value={n}>{n.toLocaleString()}</option>)}</select></label>
          <label>Seed<br /><input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value))} style={{ width: 90 }} /></label>
          <label>MC trials<br /><input type="number" value={trials} min={1} max={200} onChange={(e) => setTrials(Number(e.target.value))} style={{ width: 70 }} /></label>
          <button className="adm-btn adm-btn-primary" onClick={go} disabled={busy} data-testid="econ-run">{busy ? 'Running…' : 'Run simulation'}</button>
        </div>
        {error ? <p className="adm-error">{error}</p> : null}
        <p className="adm-muted">Seeded and reproducible. Assumptions are shown below the results — nothing is hidden. This is a planning aid, not accounting or legal advice.</p>
      </Panel>

      {run ? <Results run={run} /> : null}
    </div>
  );
}

function Row({ r, label }: { r: EconResult; label: string }): JSX.Element {
  return (
    <tr>
      <td>{label}</td>
      <td className="num"><Money micros={r.grossRevenueMicros} /></td>
      <td className="num"><Money micros={r.grossTraderPayoutsMicros} /></td>
      <td className="num">{pctOf(r.payoutToRevenuePct)}</td>
      <td className="num"><Money micros={r.contributionMicros} sign /></td>
      <td className="num">{pctOf(r.contributionMargin)}</td>
    </tr>
  );
}

function Results({ run }: { run: EconomicsRun }): JSX.Element {
  const r = run.result;
  const mc = run.monteCarlo;
  return (
    <>
      <Panel title={`Headline — ${run.scenario} · ${r.purchases.toLocaleString()} purchases`}>
        <div className="adm-stats" data-testid="econ-headline">
          <Stat label="Gross revenue" value={<Money micros={r.grossRevenueMicros} />} />
          <Stat label="Pass rate" value={pctOf(r.passRate)} />
          <Stat label="Funded accounts" value={r.fundedAccounts.toLocaleString()} />
          <Stat label="Payout recipients" value={r.payoutRecipients.toLocaleString()} sub={`${pctOf(r.purchaseToPayoutPct)} of purchases`} />
          <Stat label="Payout events" value={r.payoutEvents.toLocaleString()} />
          <Stat label="Trader payouts" value={<Money micros={r.grossTraderPayoutsMicros} />} sub={`${pctOf(r.payoutToRevenuePct)} of revenue`} />
          <Stat label="Firm split kept" value={<Money micros={r.firmRetainedSplitMicros} />} />
          <Stat label="CAC" value={<Money micros={r.cacMicros} />} />
          <Stat label="Contribution" value={<Money micros={r.contributionMicros} sign />} />
          <Stat label="Margin" value={pctOf(r.contributionMargin)} />
        </div>
      </Panel>

      <Panel title="Per product & size">
        <table className="adm-table">
          <thead><tr><th>Product</th><th className="num">Purchases</th><th className="num">Revenue</th><th className="num">Funded</th><th className="num">Recipients</th><th className="num">Trader payouts</th></tr></thead>
          <tbody>
            {r.byProduct.map((p) => (
              <tr key={p.key}>
                <td>{p.key} <span className="adm-dim">{p.model}</span></td>
                <td className="num">{p.purchases.toLocaleString()}</td>
                <td className="num"><Money micros={p.grossRevenueMicros} /></td>
                <td className="num">{p.fundedAccounts.toLocaleString()}</td>
                <td className="num">{p.payoutRecipients.toLocaleString()}</td>
                <td className="num"><Money micros={p.grossTraderPayoutsMicros} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="Payout-cap experiment (no winner is chosen — read the trade-off)">
        <table className="adm-table">
          <thead><tr><th>Schedule</th><th className="num">Revenue</th><th className="num">Trader payouts</th><th className="num">Payout/rev</th><th className="num">Contribution</th><th className="num">Margin</th></tr></thead>
          <tbody>
            <Row r={run.caps.conservative} label="Conservative" />
            <Row r={run.caps.current} label="Current" />
            <Row r={run.caps.generous} label="Generous (progressive)" />
          </tbody>
        </table>
      </Panel>

      <Panel title="Sensitivity — where the margin crosses zero">
        <table className="adm-table">
          <thead><tr><th>Payout expense ×</th><th className="num">Margin</th><th>CAC %</th><th className="num">Margin</th></tr></thead>
          <tbody>
            {run.sensitivity.payoutExpense.map((p, i) => (
              <tr key={i}>
                <td className="num">×{p.factor.toFixed(2)}</td>
                <td className="num" data-neg={p.contributionMargin < 0}>{pctOf(p.contributionMargin)}</td>
                <td className="num">{run.sensitivity.cac[i] ? `${(run.sensitivity.cac[i]!.factor * 100).toFixed(0)}%` : ''}</td>
                <td className="num">{run.sensitivity.cac[i] ? pctOf(run.sensitivity.cac[i]!.contributionMargin) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title={`Monte Carlo — ${mc.trials} trials × ${mc.purchasesPerTrial.toLocaleString()} purchases`}>
        <table className="adm-table">
          <thead><tr><th>Metric</th><th className="num">p5</th><th className="num">p25</th><th className="num">Median</th><th className="num">Mean</th><th className="num">p75</th><th className="num">p95</th></tr></thead>
          <tbody>
            <DistRow label="Revenue" d={mc.revenue} money />
            <DistRow label="Payout expense" d={mc.payoutExpense} money />
            <DistRow label="Contribution" d={mc.contribution} money />
            <DistRow label="Margin (%)" d={mc.contributionMarginBps} bps />
          </tbody>
        </table>
        <p className="adm-muted">Illustrative reserve (planning aid): <Money micros={run.reserve.reserveMicros} /> — max(pending, expected near-term) plus a stressed tail. Not accounting or legal advice.</p>
      </Panel>

      <Panel title="Assumptions used (every number is editable in a future revision)">
        <pre className="adm-json" data-testid="econ-assumptions">{JSON.stringify(run.assumptions, null, 2)}</pre>
      </Panel>
    </>
  );
}

function DistRow({ label, d, money, bps }: { label: string; d: { mean: number; median: number; p5: number; p25: number; p75: number; p95: number }; money?: boolean; bps?: boolean }): JSX.Element {
  const fmt = (v: number) => (money ? <Money micros={v} /> : bps ? `${(v / 100).toFixed(1)}%` : v.toLocaleString());
  return (
    <tr>
      <td>{label}</td>
      <td className="num">{fmt(d.p5)}</td>
      <td className="num">{fmt(d.p25)}</td>
      <td className="num">{fmt(d.median)}</td>
      <td className="num">{fmt(d.mean)}</td>
      <td className="num">{fmt(d.p75)}</td>
      <td className="num">{fmt(d.p95)}</td>
    </tr>
  );
}
