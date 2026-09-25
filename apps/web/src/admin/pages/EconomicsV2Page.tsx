/**
 * Owner economics engine (M13.0) — MODELED / SIMULATION, never accounting.
 *
 * The owner configures a scenario, customer volume, time horizon and seed, runs the
 * model server-side (deterministic, reproducible), and reads: headline economics, the
 * product-economics table, the cash timeline, the treasury/reserve view, the payout
 * and affiliate lifecycles, break-even levers, sensitivity, a seeded Monte-Carlo
 * distribution, and a scenario comparison. Every input is shown; nothing is a
 * forecast. Results are clearly separated from real financial-ops accounting.
 */
import { useState, type JSX } from 'react';
import { adminApi } from '../api';
import { Money, Panel, Stat } from '../shared';
import type { EconV2Bundle, EconV2RunResponse } from '../types';

const SCENARIOS = [
  'BASE', 'HIGH_PASS_RATE', 'HIGH_PAYOUT_RATE', 'LOW_RESET_RATE', 'HIGH_REFUND_RATE',
  'HIGH_CHARGEBACK_RATE', 'HIGH_AFFILIATE_PENETRATION', 'HIGH_CAC', 'VIRAL_GROWTH',
  'PAYOUT_STRESS', 'COMBINED_DOWNSIDE',
];
const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

export function AdminEconomicsV2Page(): JSX.Element {
  const [scenario, setScenario] = useState('BASE');
  const [customers, setCustomers] = useState(5000);
  const [horizonDays, setHorizonDays] = useState(365);
  const [seed, setSeed] = useState(2026);
  const [trials, setTrials] = useState(40);
  const [run, setRun] = useState<EconV2RunResponse | null>(null);
  const [compare, setCompare] = useState<EconV2Bundle[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      setRun(await adminApi.economicsV2Run({ scenario, seed, customers, horizonDays, trials }));
      setCompare(null);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  const doCompare = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      const names = ['BASE', 'PAYOUT_STRESS', 'COMBINED_DOWNSIDE'];
      const out: EconV2Bundle[] = [];
      for (const n of names) {
        const r = await adminApi.economicsV2Run({ scenario: n, seed, customers, horizonDays, trials: Math.min(trials, 20), persist: false });
        out.push(r.bundle);
      }
      setCompare(out);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="adm-page">
      <Panel title="Economics engine — MODELED / SIMULATION (never production accounting)">
        <div className="adm-inline-actions" style={{ flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
          <label>Scenario<br /><select value={scenario} onChange={(e) => setScenario(e.target.value)} data-testid="econ2-scenario">{SCENARIOS.map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
          <label>Customers<br /><select value={customers} onChange={(e) => setCustomers(Number(e.target.value))} data-testid="econ2-customers">{[100, 1000, 5000, 10_000, 25_000].map((n) => <option key={n} value={n}>{n.toLocaleString()}</option>)}</select></label>
          <label>Horizon<br /><select value={horizonDays} onChange={(e) => setHorizonDays(Number(e.target.value))} data-testid="econ2-horizon">{[30, 90, 180, 365].map((n) => <option key={n} value={n}>{n} days</option>)}</select></label>
          <label>Seed<br /><input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value))} style={{ width: 90 }} /></label>
          <label>MC trials<br /><input type="number" value={trials} min={1} max={200} onChange={(e) => setTrials(Number(e.target.value))} style={{ width: 70 }} /></label>
          <button className="adm-btn adm-btn-primary" onClick={go} disabled={busy} data-testid="econ2-run">{busy ? 'Running…' : 'Run model'}</button>
          <button className="adm-btn" onClick={doCompare} disabled={busy} data-testid="econ2-compare">Compare stress scenarios</button>
        </div>
        {error ? <p className="adm-error">{error}</p> : null}
        <p className="adm-muted">
          Deterministic and reproducible from (scenario/assumptions, seed, customers, horizon). Category A numbers
          (prices, caps, 90/10 split, activation, winning days) are authoritative; the funnel, cost, refund/chargeback,
          affiliate and growth figures are explicit ASSUMPTIONS — not measured Happy Trader data, not a forecast.
        </p>
      </Panel>

      {compare ? <Comparison bundles={compare} /> : null}
      {run ? <Results res={run} /> : null}
    </div>
  );
}

function Results({ res }: { res: EconV2RunResponse }): JSX.Element {
  const b = res.bundle;
  const r = b.result;
  const t = r.treasury;
  const mc = b.monteCarlo;
  const liquidityStressed = r.timeline.some((p) => p.distributableCashMicros < 0);

  return (
    <>
      <Panel title={`Headline — ${b.scenario} · ${b.customers.toLocaleString()} customers · ${b.horizonDays}d · seed ${b.seed}`}>
        <div className="adm-stats" data-testid="econ2-headline">
          <Stat label="Gross sales" value={<Money micros={r.grossSalesMicros} />} />
          <Stat label="Net revenue" value={<Money micros={r.netRevenueMicros} />} sub="after refunds & chargebacks" />
          <Stat label="Pass rate" value={pct(r.passRate)} />
          <Stat label="Funded accounts" value={r.fundedAccounts.toLocaleString()} />
          <Stat label="Payout recipients" value={r.payoutRecipients.toLocaleString()} sub={`${pct(r.purchaseToPayoutPct)} of purchases`} />
          <Stat label="Trader payouts" value={<Money micros={r.payouts.traderShareMicros} />} sub={`${pct(r.netRevenueMicros > 0 ? r.payouts.traderShareMicros / r.netRevenueMicros : 0)} of net rev`} />
          <Stat label="Affiliate expense" value={<Money micros={r.affiliate.netCommissionExpenseMicros} />} />
          <Stat label="Processing" value={<Money micros={r.processingCostMicros} />} />
          <Stat label="Operating" value={<Money micros={r.operatingCostMicros} />} />
          <Stat label="Acquisition" value={<Money micros={r.acquisitionCostMicros} />} />
          <Stat label="Modeled contribution" value={<Money micros={r.contributionMicros} sign />} sub={pct(r.contributionMargin)} />
          <Stat label="Distributable cash" value={<Money micros={t.distributableCashMicros} sign />} sub="after reserves" />
        </div>
        {liquidityStressed ? <p className="adm-error" data-testid="econ2-liquidity">⚠ Liquidity stress: distributable cash goes negative in at least one month of the timeline.</p> : null}
      </Panel>

      <Panel title="Revenue streams">
        <div className="adm-stats">
          <Stat label="Initial evaluations" value={<Money micros={r.initialRevenueMicros} />} />
          <Stat label="Resets" value={<Money micros={r.resetRevenueMicros} />} sub={`${r.resets.toLocaleString()} resets`} />
          <Stat label="Repurchases" value={<Money micros={r.repurchaseRevenueMicros} />} sub={`${r.repurchases.toLocaleString()} repurchases`} />
          <Stat label="Refund loss" value={<Money micros={r.refundLossMicros} />} sub={`${r.refunds.toLocaleString()} refunds`} />
          <Stat label="Chargeback loss" value={<Money micros={r.chargebackLossMicros} />} sub={`${r.chargebacks.toLocaleString()} chargebacks + fees ${''}`} />
        </div>
      </Panel>

      <Panel title="Payout & affiliate lifecycle (liability = incurred but not yet cash-paid)">
        <div className="adm-stats">
          <Stat label="Payout events" value={r.payouts.requestedEvents.toLocaleString()} />
          <Stat label="Gross payouts" value={<Money micros={r.payouts.grossPayoutMicros} />} />
          <Stat label="Trader share (90%)" value={<Money micros={r.payouts.traderShareMicros} />} />
          <Stat label="Firm split kept (10%)" value={<Money micros={r.payouts.firmShareMicros} />} />
          <Stat label="Paid trader share" value={<Money micros={r.payouts.paidTraderShareMicros} />} />
          <Stat label="Approved unpaid (liability)" value={<Money micros={r.payouts.approvedUnpaidTraderShareMicros} />} />
          <Stat label="Affiliate gross" value={<Money micros={r.affiliate.grossCommissionMicros} />} />
          <Stat label="Affiliate paid" value={<Money micros={r.affiliate.paidCommissionMicros} />} />
          <Stat label="Affiliate unpaid (liability)" value={<Money micros={r.affiliate.unpaidLiabilityMicros} />} />
          <Stat label="Affiliate reversed / canceled" value={<><Money micros={r.affiliate.reversedCommissionMicros} /> / <Money micros={r.affiliate.canceledCommissionMicros} /></>} />
        </div>
      </Panel>

      <Panel title="Treasury & required reserves (illustrative — assumptions shown below)">
        <table className="adm-table">
          <tbody>
            <tr><td>Cash collected (net, at horizon)</td><td className="num"><Money micros={t.cashCollectedMicros} sign /></td></tr>
            <tr><td>Payout liability</td><td className="num"><Money micros={t.payoutLiabilityMicros} /></td></tr>
            <tr><td>Affiliate liability</td><td className="num"><Money micros={t.affiliateLiabilityMicros} /></td></tr>
            <tr><td>Refund / chargeback reserve</td><td className="num"><Money micros={t.refundReserveMicros} /></td></tr>
            <tr><td>Operating reserve</td><td className="num"><Money micros={t.operatingReserveMicros} /></td></tr>
            <tr><td>Tax placeholder</td><td className="num"><Money micros={t.taxPlaceholderMicros} /></td></tr>
            <tr><td>Safety reserve (Monte-Carlo tail)</td><td className="num"><Money micros={t.safetyReserveMicros} /></td></tr>
            <tr style={{ fontWeight: 600 }}><td>Required reserve</td><td className="num"><Money micros={t.requiredReserveMicros} /></td></tr>
            <tr style={{ fontWeight: 600 }}><td>Modeled distributable cash</td><td className="num"><Money micros={t.distributableCashMicros} sign /></td></tr>
          </tbody>
        </table>
      </Panel>

      <Panel title="Product economics">
        <table className="adm-table" data-testid="econ2-products">
          <thead><tr>
            <th>Product</th><th className="num">Customers</th><th className="num">Purchases</th><th className="num">Pass</th>
            <th className="num">Funded</th><th className="num">Reset rev</th><th className="num">Total rev</th>
            <th className="num">Payout cost</th><th className="num">Affiliate</th><th className="num">Refund/CB</th>
            <th className="num">Operating</th><th className="num">Contribution</th><th className="num">/customer</th>
          </tr></thead>
          <tbody>
            {r.byProduct.map((p) => (
              <tr key={p.key}>
                <td>{p.key} <span className="adm-dim">{p.family}</span></td>
                <td className="num">{p.customers.toLocaleString()}</td>
                <td className="num">{p.purchases.toLocaleString()}</td>
                <td className="num">{p.purchases > 0 ? pct(p.passes / p.purchases) : '—'}</td>
                <td className="num">{p.fundedAccounts.toLocaleString()}</td>
                <td className="num"><Money micros={p.resetRevenueMicros ?? 0} /></td>
                <td className="num"><Money micros={p.netRevenueMicros} /></td>
                <td className="num"><Money micros={p.traderPayoutMicros} /></td>
                <td className="num"><Money micros={p.affiliateExpenseMicros} /></td>
                <td className="num"><Money micros={p.refundLossMicros + p.chargebackLossMicros} /></td>
                <td className="num"><Money micros={p.operatingAllocationMicros} /></td>
                <td className="num"><Money micros={p.contributionMicros} sign /></td>
                <td className="num"><Money micros={p.customers > 0 ? Math.round(p.contributionMicros / p.customers) : 0} sign /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="Cash timeline (per modelled month) — watch for liquidity stress before economics recover">
        <table className="adm-table" data-testid="econ2-timeline">
          <thead><tr>
            <th className="num">Month</th><th className="num">Cash in</th><th className="num">Trader payouts</th><th className="num">Affiliate</th>
            <th className="num">Refund/CB</th><th className="num">Operating</th><th className="num">Acquisition</th>
            <th className="num">Net</th><th className="num">Cumulative</th><th className="num">Reserve</th><th className="num">Distributable</th>
          </tr></thead>
          <tbody>
            {r.timeline.map((p) => (
              <tr key={p.monthIndex}>
                <td className="num">{p.monthIndex + 1}</td>
                <td className="num"><Money micros={p.cashInMicros} sign /></td>
                <td className="num"><Money micros={p.traderPayoutCashMicros} /></td>
                <td className="num"><Money micros={p.affiliateCashMicros} /></td>
                <td className="num"><Money micros={p.refundCashMicros + p.chargebackCashMicros} /></td>
                <td className="num"><Money micros={p.operatingCashMicros} /></td>
                <td className="num"><Money micros={p.acquisitionCashMicros} /></td>
                <td className="num"><Money micros={p.netCashMicros} sign /></td>
                <td className="num"><Money micros={p.cumulativeCashMicros} sign /></td>
                <td className="num"><Money micros={p.reserveRequirementMicros} /></td>
                <td className="num" data-neg={p.distributableCashMicros < 0}><Money micros={p.distributableCashMicros} sign /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="Break-even — where modeled contribution crosses zero">
        <table className="adm-table" data-testid="econ2-breakeven">
          <thead><tr><th>Lever</th><th>Break-even value</th><th>Direction</th></tr></thead>
          <tbody>
            {b.breakEven.map((be) => (
              <tr key={be.lever}>
                <td>{be.lever}</td>
                <td className="num">{be.breakEvenValue === null ? 'no crossing in range' : be.lever === 'cacPerCustomerMicros' ? <Money micros={Math.round(be.breakEvenValue)} /> : be.breakEvenValue.toFixed(3)}</td>
                <td className="adm-dim">{be.decreasingInLever ? 'contribution falls as lever rises' : 'contribution rises as lever rises'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title={`Monte Carlo — ${mc.trials} trials (p10 = downside for contribution/cash; p90 = downside for payout/reserve)`}>
        <table className="adm-table" data-testid="econ2-montecarlo">
          <thead><tr><th>Metric</th><th>Worse tail</th><th className="num">p10</th><th className="num">p25</th><th className="num">Median</th><th className="num">Mean</th><th className="num">p75</th><th className="num">p90</th></tr></thead>
          <tbody>
            <DistRow label="Net revenue" d={mc.revenue} />
            <DistRow label="Payout expense" d={mc.payoutExpense} />
            <DistRow label="Contribution" d={mc.contribution} />
            <DistRow label="Reserve requirement" d={mc.reserveRequirement} />
            <DistRow label="Distributable cash" d={mc.distributableCash} />
          </tbody>
        </table>
        <div className="adm-stats" style={{ marginTop: 12 }}>
          <Stat label="P(contribution < 0)" value={pct(mc.probContributionNegative)} />
          <Stat label="P(liquidity stress)" value={pct(mc.probLiquidityStress)} />
          <Stat label="Suggested safety reserve" value={<Money micros={mc.suggestedSafetyReserveMicros} />} />
        </div>
      </Panel>

      <Panel title="Sensitivity — payout fraction and refund rate">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <SensTable title="Avg payout fraction of cap" points={b.sensitivity['avgPayoutFractionOfCap'] ?? []} />
          <SensTable title="Refund rate" points={b.sensitivity['refundRate'] ?? []} />
        </div>
      </Panel>

      {res.id ? (
        <Panel title="Export (structured, portable)">
          <div className="adm-inline-actions" style={{ gap: 10, flexWrap: 'wrap' }}>
            {(['summary', 'product', 'timeline', 'assumptions', 'json'] as const).map((f) => (
              <a key={f} className="adm-btn" href={adminApi.economicsV2ExportUrl(res.id!, f)} target="_blank" rel="noreferrer">{f.toUpperCase()}</a>
            ))}
          </div>
          <p className="adm-muted">Run id {res.id} — stored immutably for audit and reproduction.</p>
        </Panel>
      ) : null}

      <Panel title="Assumptions used (Category B — explicit, editable, NOT measured data)">
        <pre className="adm-json" data-testid="econ2-assumptions">{JSON.stringify(b.assumptions, null, 2)}</pre>
      </Panel>
    </>
  );
}

function DistRow({ label, d }: { label: string; d: { worseTail: string; mean: number; p10: number; p25: number; median: number; p75: number; p90: number } }): JSX.Element {
  return (
    <tr>
      <td>{label}</td>
      <td className="adm-dim">{d.worseTail === 'LOW' ? 'low (p10)' : 'high (p90)'}</td>
      <td className="num"><Money micros={d.p10} sign /></td>
      <td className="num"><Money micros={d.p25} sign /></td>
      <td className="num"><Money micros={d.median} sign /></td>
      <td className="num"><Money micros={d.mean} sign /></td>
      <td className="num"><Money micros={d.p75} sign /></td>
      <td className="num"><Money micros={d.p90} sign /></td>
    </tr>
  );
}

function SensTable({ title, points }: { title: string; points: { value: number; contributionMicros: number; contributionMargin: number }[] }): JSX.Element {
  return (
    <table className="adm-table">
      <thead><tr><th>{title}</th><th className="num">Contribution</th><th className="num">Margin</th></tr></thead>
      <tbody>
        {points.map((p, i) => (
          <tr key={i}>
            <td className="num">{p.value >= 1000 ? <Money micros={p.value} /> : p.value.toFixed(2)}</td>
            <td className="num"><Money micros={p.contributionMicros} sign /></td>
            <td className="num" data-neg={p.contributionMargin < 0}>{pct(p.contributionMargin)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Comparison({ bundles }: { bundles: EconV2Bundle[] }): JSX.Element {
  return (
    <Panel title="Scenario comparison (the facts — no scenario is recommended)">
      <table className="adm-table" data-testid="econ2-comparison">
        <thead><tr><th>Scenario</th><th className="num">Net revenue</th><th className="num">Trader payouts</th><th className="num">Payout/rev</th><th className="num">Contribution</th><th className="num">Margin</th><th className="num">Reserve</th><th className="num">Distributable</th></tr></thead>
        <tbody>
          {bundles.map((b) => {
            const r = b.result;
            return (
              <tr key={b.scenario}>
                <td>{b.scenario}</td>
                <td className="num"><Money micros={r.netRevenueMicros} /></td>
                <td className="num"><Money micros={r.payouts.traderShareMicros} /></td>
                <td className="num">{pct(r.netRevenueMicros > 0 ? r.payouts.traderShareMicros / r.netRevenueMicros : 0)}</td>
                <td className="num"><Money micros={r.contributionMicros} sign /></td>
                <td className="num" data-neg={r.contributionMargin < 0}>{pct(r.contributionMargin)}</td>
                <td className="num"><Money micros={r.treasury.requiredReserveMicros} /></td>
                <td className="num"><Money micros={r.treasury.distributableCashMicros} sign /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Panel>
  );
}
