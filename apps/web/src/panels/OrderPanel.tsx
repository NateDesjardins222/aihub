import { useCallback, useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { useSession, activeInstrument, selectedAccount } from '../state/session';
import { formatMicros, pnlClass } from '../state/format';
import { useTrading } from '../trading/store';
import { newClientOrderId, tradingApi, type BracketUnit } from '../trading/api';
import { ApiRequestError } from '../api/client';
import './OrderPanel.css';

type OrderType = 'MARKET' | 'LIMIT' | 'STOP_MARKET' | 'STOP_LIMIT';

const QUICK_QTY = [1, 2, 3, 5, 10];

/**
 * The order ticket.
 *
 * Everything it shows about risk is derived from the instrument registry, so
 * "40 ticks" reads as $200 on NQ and $500 on ES without the panel knowing
 * anything about either. It submits requests and displays what the server
 * decided; it never decides anything itself.
 */
export function OrderPanel(): JSX.Element {
  const instrument = useSession(activeInstrument);
  const account = useSession(selectedAccount);
  const accountId = account?.id ?? null;

  const positions = useTrading((s) => s.positions);
  const pnl = useTrading((s) => s.pnl);
  const refresh = useTrading((s) => s.refresh);
  // Derived here rather than in the selector, so the reference stays stable
  // between renders and the store does not appear to change on every read.
  const position = useMemo(
    () => (instrument ? (positions.find((p) => p.symbol === instrument.root && p.qty !== 0) ?? null) : null),
    [instrument, positions],
  );

  const [qty, setQty] = useState(1);
  const [type, setType] = useState<OrderType>('MARKET');
  const [limitPrice, setLimitPrice] = useState('');
  const [stopPrice, setStopPrice] = useState('');
  const [tif, setTif] = useState<'DAY' | 'GTC'>('DAY');
  const [bracketOn, setBracketOn] = useState(true);
  const [bracketUnit, setBracketUnit] = useState<BracketUnit>('TICKS');
  const [stopLoss, setStopLoss] = useState('40');
  const [takeProfit, setTakeProfit] = useState('80');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  useEffect(() => {
    setMessage(null);
  }, [instrument?.root]);

  const tickValue = instrument ? instrument.tickValueMicros : 0;
  const ticksPerPoint = instrument ? instrument.ticksPerPoint : 1;

  /** Convert whatever unit the trader typed into ticks, for the read-out. */
  const toTicks = useCallback(
    (raw: string): number | null => {
      const value = Number(raw);
      if (!Number.isFinite(value) || value <= 0 || !instrument) return null;
      if (bracketUnit === 'TICKS') return Math.round(value);
      if (bracketUnit === 'POINTS') return Math.round(value * ticksPerPoint);
      // DOLLARS: how many ticks that risk buys at this size.
      return Math.floor((value * 1_000_000) / (qty * tickValue));
    },
    [bracketUnit, instrument, qty, tickValue, ticksPerPoint],
  );

  const riskTicks = toTicks(stopLoss);
  const rewardTicks = toTicks(takeProfit);
  const riskMicros = riskTicks === null ? null : riskTicks * qty * tickValue;
  const rewardMicros = rewardTicks === null ? null : rewardTicks * qty * tickValue;
  const rr =
    riskMicros && rewardMicros && riskMicros > 0 ? (rewardMicros / riskMicros).toFixed(2) : null;

  const feesMicros = instrument
    ? 2 * qty * (instrument.commissionPerSideMicros + instrument.exchangeFeesPerSideMicros)
    : 0;

  const canSubmit = Boolean(instrument && accountId) && !busy;

  const submit = useCallback(
    async (side: 'BUY' | 'SELL') => {
      if (!instrument || !accountId) return;
      setBusy(true);
      setMessage(null);
      try {
        await tradingApi.submit({
          accountId,
          clientOrderId: newClientOrderId('ui'),
          symbol: instrument.root,
          side,
          qty,
          type,
          limitPrice: type === 'LIMIT' || type === 'STOP_LIMIT' ? Number(limitPrice) : null,
          stopPrice: type === 'STOP_MARKET' || type === 'STOP_LIMIT' ? Number(stopPrice) : null,
          tif,
          bracket:
            bracketOn && (stopLoss || takeProfit)
              ? {
                  stopLoss: stopLoss ? { unit: bracketUnit, value: Number(stopLoss) } : null,
                  takeProfit: takeProfit ? { unit: bracketUnit, value: Number(takeProfit) } : null,
                }
              : null,
        });
        setMessage({ tone: 'ok', text: `${side} ${qty} ${instrument.root} submitted.` });
        await refresh();
      } catch (err) {
        // The server's machine-readable reason is surfaced verbatim: a trader
        // needs to know WHY an order was refused, not that "something failed".
        const text =
          err instanceof ApiRequestError ? `${err.code}: ${err.message}` : 'Order failed.';
        setMessage({ tone: 'bad', text });
      } finally {
        setBusy(false);
      }
    },
    [accountId, bracketOn, bracketUnit, instrument, limitPrice, qty, refresh, stopLoss, stopPrice, takeProfit, tif, type],
  );

  const act = useCallback(
    async (action: 'flatten' | 'reverse' | 'cancelAll') => {
      if (!instrument || !accountId) return;
      setBusy(true);
      setMessage(null);
      try {
        if (action === 'flatten') await tradingApi.flatten(accountId, instrument.root);
        if (action === 'reverse') await tradingApi.reverse(accountId, instrument.root);
        if (action === 'cancelAll') await tradingApi.cancelAll(accountId, instrument.root);
        await refresh();
        setMessage({ tone: 'ok', text: `${action} done.` });
      } catch (err) {
        const text =
          err instanceof ApiRequestError ? `${err.code}: ${err.message}` : 'Action failed.';
        setMessage({ tone: 'bad', text });
      } finally {
        setBusy(false);
      }
    },
    [accountId, instrument, refresh],
  );

  const needsLimit = type === 'LIMIT' || type === 'STOP_LIMIT';
  const needsStop = type === 'STOP_MARKET' || type === 'STOP_LIMIT';
  const openContracts = useMemo(
    () => positions.reduce((sum, p) => sum + Math.abs(p.signedQty), 0),
    [positions],
  );

  if (!instrument) return <div className="op-empty">No instrument selected.</div>;

  return (
    <div className="order-panel">
      <div className="op-position">
        <span className="label">Position</span>
        {position ? (
          <span className="num op-position-value">
            <b className={position.side === 'LONG' ? 'pos' : 'neg'}>{position.side}</b> {position.qty}{' '}
            @ {position.avgEntryPrice?.toFixed(instrument.pricePrecision)}
          </span>
        ) : (
          <span className="num flat">FLAT</span>
        )}
        <span className={`num ${pnlClass(position?.unrealizedPnlMicros ?? 0)}`}>
          {formatMicros(position?.unrealizedPnlMicros ?? 0, { sign: true })}
        </span>
      </div>

      <div className="op-grid">
        <label>
          <span className="label">Quantity</span>
          <input
            id="op-qty"
            className="num"
            type="number"
            min={instrument.minOrderQty}
            max={instrument.maxOrderQty}
            value={qty}
            onChange={(e) => setQty(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
          />
        </label>
        <label>
          <span className="label">Order type</span>
          <select id="op-type" value={type} onChange={(e) => setType(e.target.value as OrderType)}>
            <option value="MARKET">Market</option>
            <option value="LIMIT">Limit</option>
            <option value="STOP_MARKET">Stop market</option>
            <option value="STOP_LIMIT">Stop limit</option>
          </select>
        </label>
        <label>
          <span className="label">Limit price</span>
          <input
            id="op-limit"
            className="num"
            type="number"
            step={instrument.tickSize}
            value={limitPrice}
            disabled={!needsLimit}
            placeholder={needsLimit ? `× ${instrument.tickSize}` : '—'}
            onChange={(e) => setLimitPrice(e.target.value)}
          />
        </label>
        <label>
          <span className="label">Stop price</span>
          <input
            id="op-stop"
            className="num"
            type="number"
            step={instrument.tickSize}
            value={stopPrice}
            disabled={!needsStop}
            placeholder={needsStop ? `× ${instrument.tickSize}` : '—'}
            onChange={(e) => setStopPrice(e.target.value)}
          />
        </label>
      </div>

      <div className="op-quick">
        {QUICK_QTY.map((n) => (
          <button
            key={n}
            className={`chip ${qty === n ? 'chip-on' : ''}`}
            onClick={() => setQty(n)}
          >
            {n}
          </button>
        ))}
        <div className="hdr-spacer" />
        <select
          id="op-tif"
          className="op-tif"
          value={tif}
          onChange={(e) => setTif(e.target.value as 'DAY' | 'GTC')}
        >
          <option value="DAY">DAY</option>
          <option value="GTC">GTC</option>
        </select>
      </div>

      <div className="op-bracket">
        <div className="op-bracket-head">
          <label className="op-check">
            <input
              id="op-bracket-on"
              type="checkbox"
              checked={bracketOn}
              onChange={(e) => setBracketOn(e.target.checked)}
            />
            <span className="label">Bracket</span>
          </label>
          <div className="op-units">
            {(['TICKS', 'POINTS', 'DOLLARS'] as BracketUnit[]).map((u) => (
              <button
                key={u}
                className={`chip ${bracketUnit === u ? 'chip-on' : ''}`}
                onClick={() => setBracketUnit(u)}
                disabled={!bracketOn}
              >
                {u === 'TICKS' ? 'T' : u === 'POINTS' ? 'P' : '$'}
              </button>
            ))}
          </div>
        </div>

        <div className="op-bracket-row">
          <label>
            <span className="label">Stop loss</span>
            <input
              id="op-sl"
              className="num"
              type="number"
              value={stopLoss}
              disabled={!bracketOn}
              onChange={(e) => setStopLoss(e.target.value)}
            />
          </label>
          <label>
            <span className="label">Take profit</span>
            <input
              id="op-tp"
              className="num"
              type="number"
              value={takeProfit}
              disabled={!bracketOn}
              onChange={(e) => setTakeProfit(e.target.value)}
            />
          </label>
        </div>

        {bracketOn ? (
          <div className="op-risk">
            <span>
              Risk <b className="num neg">{riskMicros === null ? '—' : formatMicros(-riskMicros)}</b>
              {riskTicks !== null ? <em className="num"> {riskTicks}t</em> : null}
            </span>
            <span>
              Reward{' '}
              <b className="num pos">{rewardMicros === null ? '—' : formatMicros(rewardMicros)}</b>
              {rewardTicks !== null ? <em className="num"> {rewardTicks}t</em> : null}
            </span>
            {rr ? <span>R:R <b className="num">{rr}</b></span> : null}
          </div>
        ) : null}
      </div>

      <div className="op-actions">
        <button className="op-buy" disabled={!canSubmit} onClick={() => void submit('BUY')}>
          BUY {qty}
        </button>
        <button className="op-sell" disabled={!canSubmit} onClick={() => void submit('SELL')}>
          SELL {qty}
        </button>
      </div>

      <div className="op-actions op-actions-secondary">
        <button disabled={!canSubmit || !position} onClick={() => void act('flatten')}>
          Flatten
        </button>
        <button disabled={!canSubmit || !position} onClick={() => void act('reverse')}>
          Reverse
        </button>
        <button disabled={!canSubmit} onClick={() => void act('cancelAll')}>
          Cancel all
        </button>
      </div>

      {message ? (
        <div className={`op-message ${message.tone === 'ok' ? 'op-message-ok' : 'op-message-bad'}`}>
          {message.text}
        </div>
      ) : null}

      <dl className="op-facts">
        <div>
          <dt>Round turn</dt>
          <dd className="num">{formatMicros(feesMicros)}</dd>
        </div>
        <div>
          <dt>Tick value</dt>
          <dd className="num">{formatMicros(instrument.tickValueMicros)}</dd>
        </div>
        <div>
          <dt>Contracts</dt>
          <dd className="num">
            {openContracts}/{pnl?.maxContracts ?? '—'}
          </dd>
        </div>
        <div>
          <dt>Equity</dt>
          <dd className="num">{pnl ? formatMicros(pnl.equityMicros) : '—'}</dd>
        </div>
      </dl>
    </div>
  );
}
