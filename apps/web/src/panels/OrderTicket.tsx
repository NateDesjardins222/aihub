/**
 * The order ticket.
 *
 * Contract, order type, size, position, buy and sell. That is the whole of it:
 * a trader placing an order is choosing a side and a size, not configuring a
 * platform, so time in force, bracket behaviour, fee tables and account
 * arithmetic are in Settings and in the account bar respectively.
 *
 * It submits requests and shows what the server decided. Nothing in it computes
 * a P&L, a balance or an account state of its own, and it reports a REJECTION
 * but not a confirmation - the position line and the blotter are the
 * confirmation, and a line of chat saying "submitted" is noise above them.
 */
import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { useSession, activeInstrument, selectedAccount } from '../state/session';
import { formatMicros, pnlClass } from '../state/format';
import { useTrading } from '../trading/store';
import { newClientOrderId, tradingApi } from '../trading/api';
import { useExecution } from '../state/execution';
import { ApiRequestError } from '../api/client';
import { MASK, useTraining } from '../state/training';
import { bracketLevels } from '../chart/protection';
import { Icon } from '../ui/Icon';
import './OrderTicket.css';

type OrderType = 'MARKET' | 'LIMIT' | 'STOP_MARKET' | 'STOP_LIMIT';

const PRESETS = [1, 3, 5, 10, 15];

export function OrderTicket(): JSX.Element {
  const instrument = useSession(activeInstrument);
  const account = useSession(selectedAccount);
  const accountId = account?.id ?? null;

  const positions = useTrading((s) => s.positions);
  const orders = useTrading((s) => s.orders);
  const canTrade = useTrading((s) => s.rules?.canTrade ?? true);
  const refresh = useTrading((s) => s.refresh);
  const showPnl = useTraining((s) => s.visibility.pnl);
  const defaults = useExecution((s) => s.defaults);

  const [qty, setQty] = useState(1);
  const [type, setType] = useState<OrderType>('MARKET');
  const [limitPrice, setLimitPrice] = useState('');
  const [stopPrice, setStopPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => setError(null), [instrument?.root]);

  const run = useCallback(
    async (work: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await work();
        await refresh();
      } catch (err) {
        // The server's machine-readable reason is surfaced verbatim: a trader
        // needs to know WHY an order was refused.
        setError(
          err instanceof ApiRequestError ? `${err.code.replace(/_/g, ' ')}: ${err.message}` : 'Request failed.',
        );
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const submit = useCallback(
    (side: 'BUY' | 'SELL') => {
      if (!instrument || !accountId) return;
      void run(async () => {
        await tradingApi.submit({
          accountId,
          clientOrderId: newClientOrderId('ticket'),
          symbol: instrument.root,
          side,
          qty,
          type,
          limitPrice: type === 'LIMIT' || type === 'STOP_LIMIT' ? Number(limitPrice) : null,
          stopPrice: type === 'STOP_MARKET' || type === 'STOP_LIMIT' ? Number(stopPrice) : null,
          tif: defaults.tif,
          // Only AUTO attaches anything. On OFF - the default - nothing
          // protective exists until it is dragged off the position marker.
          bracket:
            defaults.bracketMode === 'AUTO' && (defaults.stopTicks > 0 || defaults.targetTicks > 0)
              ? {
                  stopLoss: defaults.stopTicks > 0 ? { unit: 'TICKS', value: defaults.stopTicks } : null,
                  takeProfit:
                    defaults.targetTicks > 0 ? { unit: 'TICKS', value: defaults.targetTicks } : null,
                }
              : null,
        });
      });
    },
    [accountId, defaults, instrument, limitPrice, qty, run, stopPrice, type],
  );

  if (!instrument) return <div className="tk-empty">No instrument selected.</div>;

  const needsLimit = type === 'LIMIT' || type === 'STOP_LIMIT';
  const needsStop = type === 'STOP_MARKET' || type === 'STOP_LIMIT';
  const ready = Boolean(accountId) && !busy;

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
        <select id="tk-type" value={type} onChange={(event) => setType(event.target.value as OrderType)}>
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

      <div className="tk-field">
        <span className="tk-label"># of contracts</span>
        {/*
          The steppers sit BESIDE the number, not among the presets.
          Wrapping them into the preset row - which is what a grid that fits its
          own columns does at this width - cost the ticket a whole extra line
          and pushed it past the height it is allowed.
        */}
        <div className="tk-qty-row">
          <button
            className="tk-step"
            onClick={() => setQty((value) => Math.max(1, value - 1))}
            title="One fewer"
            aria-label="Fewer contracts"
          >
            <Icon name="minus" size={13} />
          </button>
          <input
            id="tk-qty"
            className="num tk-qty"
            type="number"
            min={instrument.minOrderQty}
            max={instrument.maxOrderQty}
            value={qty}
            onChange={(event) => setQty(Math.max(1, Math.floor(Number(event.target.value) || 1)))}
          />
          <button
            className="tk-step"
            onClick={() => setQty((value) => Math.min(999, value + 1))}
            title="One more"
            aria-label="More contracts"
          >
            <Icon name="plus" size={13} />
          </button>
        </div>
        <div className="tk-presets">
          {PRESETS.map((preset) => (
            <button
              key={preset}
              className={`tk-preset ${qty === preset ? 'tk-preset-on' : ''}`}
              onClick={() => setQty(preset)}
            >
              {preset}
            </button>
          ))}
        </div>
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
            <span className={`num tk-pos-pnl ${showPnl ? pnlClass(position.unrealizedPnlMicros) : 'flat'}`}>
              {showPnl ? formatMicros(position.unrealizedPnlMicros, { sign: true }) : MASK}
            </span>
          </>
        ) : (
          <span className="tk-pos-flat">No active position</span>
        )}
      </div>

      <div className="tk-actions">
        <button
          className="tk-buy"
          disabled={!ready || !canTrade}
          onClick={() => submit('BUY')}
          data-testid="buy"
        >
          BUY <b>{qty}</b>
        </button>
        <button
          className="tk-sell"
          disabled={!ready || !canTrade}
          onClick={() => submit('SELL')}
          data-testid="sell"
        >
          SELL <b>{qty}</b>
        </button>
      </div>

      <div className="tk-grid2">
        <button
          disabled={!ready || !position}
          onClick={() => void run(() => tradingApi.flatten(accountId!, instrument.root))}
        >
          Close
        </button>
        <button
          disabled={!ready || !position || !canTrade}
          onClick={() => void run(() => tradingApi.reverse(accountId!, instrument.root))}
        >
          Reverse
        </button>
        <button
          className="tk-wide"
          disabled={!ready || workingOrders.length === 0}
          onClick={() => void run(() => tradingApi.cancelAll(accountId!, instrument.root))}
        >
          Cancel orders{workingOrders.length > 0 ? ` (${workingOrders.length})` : ''}
        </button>
        {position && defaults.bracketMode === 'AUTO' ? (
          <button
            className="tk-wide"
            disabled={!ready}
            onClick={() => {
              const levels = bracketLevels(
                position,
                defaults.stopTicks,
                defaults.targetTicks,
                instrument.tickSize,
              );
              void run(() =>
                tradingApi.protect(accountId!, instrument.root, {
                  ...(levels.stopPrice !== null ? { stopPrice: levels.stopPrice } : {}),
                  ...(levels.targetPrice !== null ? { targetPrice: levels.targetPrice } : {}),
                }),
              );
            }}
            title="Place the configured stop and target around this position"
          >
            Protect
          </button>
        ) : null}
      </div>

      {error ? (
        <div className="tk-error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
