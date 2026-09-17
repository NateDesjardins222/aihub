/**
 * The order ticket.
 *
 * Shaped after the reference: Contract, Order Type, Contracts, the quote block,
 * the position, quick quantities, Position Bracket, Buy/Sell, then the position
 * and order actions. Dense, narrow, and content-height - there is no stretch
 * and no blank half-screen below it.
 *
 * It submits requests and shows what the server decided. Every figure in it -
 * risk, reward, fees, equity - is derived from the instrument registry or from
 * a server response; it computes no P&L and no account state of its own.
 *
 * On honesty: the quote block shows bid and ask only when the provider says it
 * supplies top of book. This feed does not, so it says so rather than drawing a
 * plausible-looking spread around the last trade.
 */
import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { useSession, activeInstrument, selectedAccount } from '../state/session';
import { formatMicros, pnlClass } from '../state/format';
import { useTrading } from '../trading/store';
import { newClientOrderId, tradingApi, type BracketUnit } from '../trading/api';
import { fetchMarketStatus } from '../market/api';
import { marketStream } from '../market/stream';
import { ApiRequestError } from '../api/client';
import { MASK, useTraining } from '../state/training';
import { bracketLevels, type BracketMode } from '../chart/PriceMarkers';
import { Icon } from '../ui/Icon';
import './OrderTicket.css';

type OrderType = 'MARKET' | 'LIMIT' | 'STOP_MARKET' | 'STOP_LIMIT';

const QUICK_QTY = [1, 2, 3, 5, 10, 15];

const BRACKET_MODES: ReadonlyArray<{ id: BracketMode; label: string; hint: string }> = [
  {
    id: 'MANUAL',
    label: 'Manual',
    hint: 'A fill draws the position marker. Add the stop and target from it, then drag them.',
  },
  {
    id: 'AUTO',
    label: 'Auto',
    hint: 'Protective orders are placed as soon as the entry fills, at the distances below.',
  },
  { id: 'OFF', label: 'Off', hint: 'No protective orders are created.' },
];

export interface OrderTicketProps {
  readonly bracketMode: BracketMode;
  readonly onBracketMode: (mode: BracketMode) => void;
  readonly stopTicks: number;
  readonly targetTicks: number;
  readonly onStopTicks: (ticks: number) => void;
  readonly onTargetTicks: (ticks: number) => void;
}

export function OrderTicket({
  bracketMode,
  onBracketMode,
  stopTicks,
  targetTicks,
  onStopTicks,
  onTargetTicks,
}: OrderTicketProps): JSX.Element {
  const instrument = useSession(activeInstrument);
  const account = useSession(selectedAccount);
  const accountId = account?.id ?? null;

  const positions = useTrading((s) => s.positions);
  const orders = useTrading((s) => s.orders);
  const pnl = useTrading((s) => s.pnl);
  const canTrade = useTrading((s) => s.rules?.canTrade ?? true);
  const refresh = useTrading((s) => s.refresh);
  const showPnl = useTraining((s) => s.visibility.pnl);
  const showBalance = useTraining((s) => s.visibility.balance);

  const [qty, setQty] = useState(1);
  const [type, setType] = useState<OrderType>('MARKET');
  const [limitPrice, setLimitPrice] = useState('');
  const [stopPrice, setStopPrice] = useState('');
  const [tif, setTif] = useState<'DAY' | 'GTC'>('DAY');
  const [unit, setUnit] = useState<BracketUnit>('TICKS');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [last, setLast] = useState<number | null>(null);
  const [topOfBook, setTopOfBook] = useState<{ bid: number | null; ask: number | null } | null>(null);
  const [providesTopOfBook, setProvidesTopOfBook] = useState<boolean | null>(null);

  const position = useMemo(
    () =>
      instrument
        ? (positions.find((p) => p.symbol === instrument.root && p.qty !== 0) ?? null)
        : null,
    [instrument, positions],
  );
  const workingOrders = useMemo(
    () =>
      orders.filter(
        (order) =>
          order.symbol === instrument?.root &&
          (order.status === 'WORKING' || order.status === 'PARTIALLY_FILLED'),
      ),
    [orders, instrument],
  );

  useEffect(() => setMessage(null), [instrument?.root]);

  // The last trade comes off the stream; whether the feed has a book at all is
  // a capability question, asked once.
  useEffect(() => {
    if (!instrument) return;
    marketStream.connect();
    return marketStream.subscribeQuote(instrument.root, (quote) => {
      setLast(quote.last);
      setTopOfBook({ bid: quote.bid, ask: quote.ask });
    });
  }, [instrument]);

  useEffect(() => {
    void fetchMarketStatus()
      .then((status) => setProvidesTopOfBook(status.capabilities?.providesTopOfBook ?? false))
      .catch(() => setProvidesTopOfBook(null));
  }, []);

  const tickValue = instrument?.tickValueMicros ?? 0;
  const ticksPerPoint = instrument?.ticksPerPoint ?? 1;

  /** Whatever unit the trader typed, in ticks. */
  const toTicks = useCallback(
    (value: number): number => {
      if (!Number.isFinite(value) || value <= 0) return 0;
      if (unit === 'TICKS') return Math.round(value);
      if (unit === 'POINTS') return Math.round(value * ticksPerPoint);
      return Math.floor((value * 1_000_000) / Math.max(1, qty * tickValue));
    },
    [qty, tickValue, ticksPerPoint, unit],
  );

  const riskMicros = stopTicks * qty * tickValue;
  const rewardMicros = targetTicks * qty * tickValue;
  const rr = riskMicros > 0 ? (rewardMicros / riskMicros).toFixed(2) : null;
  const feesMicros = instrument
    ? 2 * qty * (instrument.commissionPerSideMicros + instrument.exchangeFeesPerSideMicros)
    : 0;
  const openContracts = useMemo(
    () => positions.reduce((sum, p) => sum + Math.abs(p.signedQty), 0),
    [positions],
  );

  const run = useCallback(
    async (label: string, work: () => Promise<unknown>) => {
      setBusy(true);
      setMessage(null);
      try {
        await work();
        await refresh();
        setMessage({ tone: 'ok', text: label });
      } catch (err) {
        // The server's machine-readable reason is surfaced verbatim: a trader
        // needs to know WHY an order was refused.
        setMessage({
          tone: 'bad',
          text: err instanceof ApiRequestError ? `${err.code}: ${err.message}` : 'Request failed.',
        });
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const submit = useCallback(
    (side: 'BUY' | 'SELL') => {
      if (!instrument || !accountId) return;
      void run(`${side} ${qty} ${instrument.root} submitted.`, async () => {
        await tradingApi.submit({
          accountId,
          clientOrderId: newClientOrderId('ticket'),
          symbol: instrument.root,
          side,
          qty,
          type,
          limitPrice: type === 'LIMIT' || type === 'STOP_LIMIT' ? Number(limitPrice) : null,
          stopPrice: type === 'STOP_MARKET' || type === 'STOP_LIMIT' ? Number(stopPrice) : null,
          tif,
          // AUTO attaches the bracket to the entry, so the legs are created
          // server-side the moment it fills. MANUAL and OFF send none: nothing
          // protective exists until the trader asks for it.
          bracket:
            bracketMode === 'AUTO' && (stopTicks > 0 || targetTicks > 0)
              ? {
                  stopLoss: stopTicks > 0 ? { unit: 'TICKS', value: stopTicks } : null,
                  takeProfit: targetTicks > 0 ? { unit: 'TICKS', value: targetTicks } : null,
                }
              : null,
        });
      });
    },
    [
      accountId,
      bracketMode,
      instrument,
      limitPrice,
      qty,
      run,
      stopPrice,
      stopTicks,
      targetTicks,
      tif,
      type,
    ],
  );

  const protectNow = useCallback(() => {
    if (!instrument || !accountId || !position) return;
    const levels = bracketLevels(position, stopTicks, targetTicks, instrument.tickSize);
    void run('Protective orders placed.', () =>
      tradingApi.protect(accountId, instrument.root, {
        ...(levels.stopPrice !== null ? { stopPrice: levels.stopPrice } : {}),
        ...(levels.targetPrice !== null ? { targetPrice: levels.targetPrice } : {}),
      }),
    );
  }, [accountId, instrument, position, run, stopTicks, targetTicks]);

  if (!instrument) return <div className="tk-empty">No instrument selected.</div>;

  const needsLimit = type === 'LIMIT' || type === 'STOP_LIMIT';
  const needsStop = type === 'STOP_MARKET' || type === 'STOP_LIMIT';
  const ready = Boolean(accountId) && !busy;
  const hasBook = providesTopOfBook === true && topOfBook !== null;
  const mode = BRACKET_MODES.find((m) => m.id === bracketMode) ?? BRACKET_MODES[0]!;

  return (
    <div className="tk" data-testid="order-ticket">
      <label className="tk-field">
        <span className="tk-label">Contract</span>
        <div className="tk-contract">
          <span className="num">{instrument.activeContract.code}</span>
          <span className="tk-contract-root">{instrument.root}</span>
        </div>
      </label>

      <label className="tk-field">
        <span className="tk-label">Order type</span>
        <select
          id="tk-type"
          value={type}
          onChange={(event) => setType(event.target.value as OrderType)}
        >
          <option value="MARKET">Market</option>
          <option value="LIMIT">Limit</option>
          <option value="STOP_MARKET">Stop market</option>
          <option value="STOP_LIMIT">Stop limit</option>
        </select>
      </label>

      {needsLimit || needsStop ? (
        <div className="tk-row">
          {needsLimit ? (
            <label className="tk-field">
              <span className="tk-label">Limit</span>
              <input
                id="tk-limit"
                className="num"
                type="number"
                step={instrument.tickSize}
                value={limitPrice}
                placeholder={`× ${instrument.tickSize}`}
                onChange={(event) => setLimitPrice(event.target.value)}
              />
            </label>
          ) : null}
          {needsStop ? (
            <label className="tk-field">
              <span className="tk-label">Stop</span>
              <input
                id="tk-stop"
                className="num"
                type="number"
                step={instrument.tickSize}
                value={stopPrice}
                placeholder={`× ${instrument.tickSize}`}
                onChange={(event) => setStopPrice(event.target.value)}
              />
            </label>
          ) : null}
        </div>
      ) : null}

      <label className="tk-field">
        <span className="tk-label"># of contracts</span>
        <input
          id="tk-qty"
          className="num tk-qty-input"
          type="number"
          min={instrument.minOrderQty}
          max={instrument.maxOrderQty}
          value={qty}
          onChange={(event) => setQty(Math.max(1, Math.floor(Number(event.target.value) || 1)))}
        />
      </label>

      {/* The quote block. Bid and ask appear only if the provider has them. */}
      <div className="tk-quote" data-testid="quote-block">
        {hasBook ? (
          <>
            <div className="tk-quote-cell tk-bid">
              <span className="tk-label">Bid</span>
              <span className="num">
                {topOfBook!.bid?.toFixed(instrument.pricePrecision) ?? '—'}
              </span>
            </div>
            <div className="tk-quote-cell tk-lastc">
              <span className="tk-label">Last</span>
              <span className="num">{last?.toFixed(instrument.pricePrecision) ?? '—'}</span>
            </div>
            <div className="tk-quote-cell tk-ask">
              <span className="tk-label">Ask</span>
              <span className="num">
                {topOfBook!.ask?.toFixed(instrument.pricePrecision) ?? '—'}
              </span>
            </div>
          </>
        ) : (
          <>
            <div className="tk-quote-cell tk-lastc tk-quote-wide">
              <span className="tk-label">Last traded</span>
              <span className="num tk-last-big">
                {last?.toFixed(instrument.pricePrecision) ?? '—'}
              </span>
            </div>
            <div
              className="tk-quote-note"
              title="The development feed carries trades and bars but no order book. Bid, ask and depth are not shown rather than being invented."
            >
              no bid/ask on this feed
            </div>
          </>
        )}
      </div>

      <div className={`tk-position ${position ? 'tk-position-open' : ''}`} data-testid="ticket-position">
        {position ? (
          <>
            <span className={`tk-pos-side ${position.side === 'LONG' ? 'pos' : 'neg'}`}>
              {position.side} {position.qty}
            </span>
            <span className="num tk-pos-at">
              @ {position.avgEntryPrice?.toFixed(instrument.pricePrecision) ?? '—'}
            </span>
            <span className={`num ${showPnl ? pnlClass(position.unrealizedPnlMicros) : 'flat'}`}>
              {showPnl ? formatMicros(position.unrealizedPnlMicros, { sign: true }) : MASK}
            </span>
          </>
        ) : (
          <span className="tk-pos-flat">No active position</span>
        )}
      </div>

      <div className="tk-quick">
        {QUICK_QTY.map((n) => (
          <button
            key={n}
            className={`tk-chip ${qty === n ? 'tk-chip-on' : ''}`}
            onClick={() => setQty(n)}
          >
            {n}
          </button>
        ))}
        <button className="tk-chip" onClick={() => setQty((q) => Math.max(1, q - 1))} title="One fewer">
          <Icon name="minus" size={10} />
        </button>
        <button className="tk-chip" onClick={() => setQty((q) => Math.min(999, q + 1))} title="One more">
          <Icon name="plus" size={10} />
        </button>
      </div>

      <div className="tk-bracket">
        <div className="tk-bracket-head">
          <span className="tk-label">Position bracket</span>
          <div className="tk-modes">
            {BRACKET_MODES.map((m) => (
              <button
                key={m.id}
                className={`tk-chip ${bracketMode === m.id ? 'tk-chip-on' : ''}`}
                onClick={() => onBracketMode(m.id)}
                title={m.hint}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        {bracketMode === 'OFF' ? null : (
          <>
            <div className="tk-row tk-bracket-row">
              <label className="tk-field">
                <span className="tk-label">Stop</span>
                <input
                  id="tk-sl"
                  className="num"
                  type="number"
                  min={0}
                  value={displayValue(stopTicks, unit, ticksPerPoint, qty, tickValue)}
                  onChange={(event) => onStopTicks(toTicks(Number(event.target.value)))}
                />
              </label>
              <label className="tk-field">
                <span className="tk-label">Target</span>
                <input
                  id="tk-tp"
                  className="num"
                  type="number"
                  min={0}
                  value={displayValue(targetTicks, unit, ticksPerPoint, qty, tickValue)}
                  onChange={(event) => onTargetTicks(toTicks(Number(event.target.value)))}
                />
              </label>
              <div className="tk-units">
                {(['TICKS', 'POINTS', 'DOLLARS'] as BracketUnit[]).map((u) => (
                  <button
                    key={u}
                    className={`tk-chip tk-chip-tiny ${unit === u ? 'tk-chip-on' : ''}`}
                    onClick={() => setUnit(u)}
                    title={u.toLowerCase()}
                  >
                    {u === 'TICKS' ? 'T' : u === 'POINTS' ? 'P' : '$'}
                  </button>
                ))}
              </div>
            </div>

            <div className="tk-rr">
              <span>
                Risk <b className="num neg">{formatMicros(-riskMicros)}</b>
                <em className="num"> {stopTicks}t</em>
              </span>
              <span>
                Reward <b className="num pos">{formatMicros(rewardMicros)}</b>
                <em className="num"> {targetTicks}t</em>
              </span>
              {rr ? (
                <span>
                  R:R <b className="num">{rr}</b>
                </span>
              ) : null}
            </div>

            {bracketMode === 'MANUAL' ? (
              <p className="tk-hint">{mode.hint}</p>
            ) : null}
          </>
        )}
      </div>

      <div className="tk-actions">
        <button
          className="tk-buy"
          disabled={!ready || !canTrade}
          onClick={() => submit('BUY')}
          data-testid="buy"
        >
          BUY +{qty} @ {type === 'MARKET' ? 'MARKET' : type === 'LIMIT' ? 'LIMIT' : 'STOP'}
        </button>
        <button
          className="tk-sell"
          disabled={!ready || !canTrade}
          onClick={() => submit('SELL')}
          data-testid="sell"
        >
          SELL −{qty} @ {type === 'MARKET' ? 'MARKET' : type === 'LIMIT' ? 'LIMIT' : 'STOP'}
        </button>
      </div>

      <div className="tk-grid2">
        <button
          disabled={!ready || !position || bracketMode === 'OFF'}
          onClick={protectNow}
          title="Place the stop and target above, as real OCO orders, around the current position"
        >
          Protect position
        </button>
        <button
          disabled={!ready || !position}
          onClick={() =>
            void run('Position closed.', () => tradingApi.flatten(accountId!, instrument.root))
          }
        >
          Close position
        </button>
        <button
          disabled={!ready || !position || !canTrade}
          onClick={() =>
            void run('Position reversed.', () => tradingApi.reverse(accountId!, instrument.root))
          }
        >
          Reverse
        </button>
        <button
          disabled={!ready || workingOrders.length === 0}
          onClick={() =>
            void run('Orders canceled.', () => tradingApi.cancelAll(accountId!, instrument.root))
          }
        >
          Cancel{workingOrders.length > 0 ? ` (${workingOrders.length})` : ' orders'}
        </button>
      </div>

      <div className="tk-tif">
        <span className="tk-label">Time in force</span>
        <div className="tk-modes">
          {(['DAY', 'GTC'] as const).map((value) => (
            <button
              key={value}
              className={`tk-chip ${tif === value ? 'tk-chip-on' : ''}`}
              onClick={() => setTif(value)}
            >
              {value}
            </button>
          ))}
        </div>
      </div>

      {message ? (
        <div className={`tk-msg ${message.tone === 'ok' ? 'tk-msg-ok' : 'tk-msg-bad'}`} role="status">
          {message.text}
        </div>
      ) : null}

      <dl className="tk-facts">
        <div>
          <dt>Tick</dt>
          <dd className="num">{formatMicros(instrument.tickValueMicros)}</dd>
        </div>
        <div>
          <dt>Round turn</dt>
          <dd className="num">{formatMicros(feesMicros)}</dd>
        </div>
        <div>
          <dt>Contracts</dt>
          <dd className="num">
            {openContracts}/{pnl?.maxContracts ?? account?.ruleTemplate.maxContracts ?? '—'}
          </dd>
        </div>
        <div>
          <dt>Equity</dt>
          <dd className="num">
            {showBalance ? (pnl ? formatMicros(pnl.equityMicros) : '—') : MASK}
          </dd>
        </div>
      </dl>
    </div>
  );
}

/** Show the stored tick distance in whichever unit the trader is using. */
function displayValue(
  ticks: number,
  unit: BracketUnit,
  ticksPerPoint: number,
  qty: number,
  tickValueMicros: number,
): number {
  if (unit === 'TICKS') return ticks;
  if (unit === 'POINTS') return Number((ticks / ticksPerPoint).toFixed(4));
  return Math.round((ticks * qty * tickValueMicros) / 1_000_000);
}
