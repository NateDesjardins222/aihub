import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { useSession, activeInstrument } from '../state/session';
import { marketStream } from '../market/stream';
import { fetchMarketStatus } from '../market/api';
import './DomPanel.css';

/**
 * Price ladder.
 *
 * The Milestone 2 feed carries no order book at all — no bid, no ask, no depth.
 * Rather than drawing plausible-looking ladder rows around the last price, this
 * panel shows exactly what the feed provides and states what is missing. The
 * full ladder arrives in Milestone 7, and real depth requires a licensed feed.
 */
export function DomPanel(): JSX.Element {
  const instrument = useSession(activeInstrument);
  const activeSymbol = useSession((s) => s.activeSymbol);
  const [last, setLast] = useState<number | null>(null);
  const [exchangeTs, setExchangeTs] = useState<number | null>(null);
  const [depthAvailable, setDepthAvailable] = useState<boolean | null>(null);
  const [depthLevels, setDepthLevels] = useState(0);

  useEffect(() => {
    marketStream.connect();
    return marketStream.subscribeQuote(activeSymbol, (quote) => {
      setLast(quote.last);
      setExchangeTs(quote.exchangeTs);
    });
  }, [activeSymbol]);

  useEffect(() => {
    void fetchMarketStatus()
      .then((status) => {
        setDepthAvailable(status.depthAvailable);
        setDepthLevels(status.depthLevels);
      })
      .catch(() => setDepthAvailable(null));
  }, []);

  const precision = instrument?.pricePrecision ?? 2;

  return (
    <div className="dom-panel">
      <div className="dom-banner">
        <strong>MARKET DEPTH UNAVAILABLE</strong>
        <p>
          The development feed provides {depthLevels} book levels. It publishes OHLCV and a
          last traded price only — no bid, no ask, no depth. Ladder rows are not shown because
          inventing them would be fabricating market data.
        </p>
        <p>Level 2 depth requires a licensed exchange feed.</p>
      </div>

      <table className="dom-table">
        <thead>
          <tr>
            <th className="right">Bid size</th>
            <th className="right">Bid</th>
            <th className="right">Price</th>
            <th>Ask</th>
            <th>Ask size</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="right num dom-missing">—</td>
            <td className="right num dom-missing">—</td>
            <td className="right num dom-last">
              {last === null ? '—' : last.toFixed(precision)}
            </td>
            <td className="num dom-missing">—</td>
            <td className="num dom-missing">—</td>
          </tr>
        </tbody>
      </table>

      <div className="dom-footer">
        <span className="label">Last exchange update</span>
        <span className="num">
          {exchangeTs
            ? new Intl.DateTimeFormat('en-US', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false,
                timeZone: instrument?.sessionTimezone ?? 'UTC',
              }).format(exchangeTs)
            : '—'}
        </span>
      </div>

      {depthAvailable ? (
        <div className="dom-footer">A depth-capable feed is attached; the ladder is Milestone 7.</div>
      ) : null}
    </div>
  );
}
