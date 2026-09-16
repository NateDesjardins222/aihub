import { useSession, activeInstrument } from '../state/session';
import { Pending } from './Pending';
import './ChartPanel.css';
import type { JSX } from 'react';

const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '1D'] as const;

/**
 * Centre chart region.
 *
 * The toolbar above the canvas is the real chart toolbar; its controls light up
 * as the chart engine lands in Milestone 3. The symbol selector already works,
 * because instruments are real data served by the API.
 */
export function ChartPanel(): JSX.Element {
  const instruments = useSession((s) => s.instruments);
  const activeSymbol = useSession((s) => s.activeSymbol);
  const setActiveSymbol = useSession((s) => s.setActiveSymbol);
  const instrument = useSession(activeInstrument);

  return (
    <section className="chart-panel">
      <div className="chart-toolbar">
        <select
          className="chart-symbol"
          value={activeSymbol}
          onChange={(e) => setActiveSymbol(e.target.value)}
          title="Select instrument"
        >
          {instruments.map((i) => (
            <option key={i.root} value={i.root}>
              {i.root} — {i.description}
            </option>
          ))}
        </select>

        {instrument ? (
          <span className="chart-contract" title="Front-month contract, resolved from the exchange listing cycle">
            {instrument.activeContract.code}
          </span>
        ) : null}

        <div className="chart-tf">
          {TIMEFRAMES.map((tf) => (
            <button key={tf} className="tf-btn" disabled title="Timeframes activate with the chart engine (Milestone 3)">
              {tf}
            </button>
          ))}
        </div>

        <div className="chart-toolbar-spacer" />

        {instrument ? (
          <div className="chart-specs num" title="Resolved from the central instrument registry">
            <span>
              tick <b>{instrument.tickSize}</b>
            </span>
            <span>
              = <b>${(instrument.tickValueMicros / 1_000_000).toFixed(2)}</b>
            </span>
            <span>
              pt <b>${(instrument.pointValueMicros / 1_000_000).toFixed(2)}</b>
            </span>
          </div>
        ) : null}
      </div>

      <div className="chart-canvas">
        <Pending title="Chart engine" milestone="Milestone 3">
          Real exchange-derived candles for {activeSymbol} load here once the market-data
          gateway and candle aggregator are wired. No placeholder series is drawn — a chart
          showing invented prices would be worse than an empty one.
        </Pending>
      </div>
    </section>
  );
}
