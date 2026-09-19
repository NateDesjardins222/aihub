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
import { tradingApi } from '../trading/api';
import { sendIntent, useFlights } from '../trading/flight';
import { useExecution } from '../state/execution';
import { describeRejection } from '../trading/rejection';
import { MASK, useTraining } from '../state/training';
import { bracketLevels, breakEvenPrice, partialQty } from '../chart/protection';
import { Icon } from '../ui/Icon';
import './OrderTicket.css';

type OrderType = 'MARKET' | 'LIMIT' | 'STOP_MARKET' | 'STOP_LIMIT';

const PRESETS = [1, 3, 5, 10, 15];

/** How long a button stays armed before it forgets it was asked. */
const ARM_MS = 4_000;

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
  /*
   * The armed side, when the trader has asked to be asked.
   *
   * A catch rather than a dialog: the button itself becomes the question, so
   * nothing covers the chart and the answer is in the same place as the
   * question. It disarms on its own, because a button left armed for a minute
   * is a trap.
   */
  const [armed, setArmed] = useState<'BUY' | 'SELL' | null>(null);

  /*
   * What Atlas has ASKED for, which is not what has happened.
   *
   * A flight is the client's own record of a submission that is still in the
   * air. It never says "filled" - the position line and the blotter say that,
   * from server state - it says "this request is out there", which is the one
   * thing the browser genuinely knows and the terminal used to keep to itself.
   */
  const flights = useFlights((s) => s.flights);
  const pending = useMemo(
    () =>
      flights.filter(
        (f) => f.accountId === accountId && f.symbol === instrument?.root && f.phase === 'SENDING',
      ),
    [accountId, flights, instrument],
  );

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

  // Anything that changes WHAT would be sent disarms it: an armed BUY 3 is
  // not consent to BUY 10.
  useEffect(() => setArmed(null), [instrument?.root, qty, type, accountId]);

  useEffect(() => {
    if (armed === null) return undefined;
    const timer = window.setTimeout(() => setArmed(null), ARM_MS);
    return () => window.clearTimeout(timer);
  }, [armed]);

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
        setError(describeRejection(err));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const submit = useCallback(
    (side: 'BUY' | 'SELL', pressedAt?: number) => {
      if (!instrument || !accountId) return;
      /*
       * One intent, one order.
       *
       * The key describes WHAT was asked for rather than when, so a double
       * click, a button pressed together with its hotkey, or a touch that
       * fired both events collapse into the single order they meant. A
       * deliberate second press, after the first is acknowledged, is a second
       * order - that is how a trader scales into a position, and swallowing it
       * would be worse than sending it.
       */
      const intent = `ticket:${accountId}:${instrument.root}:${side}:${qty}:${type}`;
      const bracket =
        defaults.bracketMode === 'AUTO' && (defaults.stopTicks > 0 || defaults.targetTicks > 0)
          ? {
              stopLoss: defaults.stopTicks > 0 ? { unit: 'TICKS' as const, value: defaults.stopTicks } : null,
              takeProfit:
                defaults.targetTicks > 0 ? { unit: 'TICKS' as const, value: defaults.targetTicks } : null,
            }
          : null;
      void run(() =>
        sendIntent(
          {
            intent,
            label: `${side} ${qty} ${instrument.root}`,
            accountId,
            symbol: instrument.root,
            prefix: 'ticket',
            ...(pressedAt === undefined ? {} : { pressedAt }),
          },
          (clientOrderId) =>
            tradingApi.submit({
              accountId,
              clientOrderId,
              symbol: instrument.root,
              side,
              qty,
              type,
              limitPrice: type === 'LIMIT' || type === 'STOP_LIMIT' ? Number(limitPrice) : null,
              stopPrice: type === 'STOP_MARKET' || type === 'STOP_LIMIT' ? Number(stopPrice) : null,
              tif: defaults.tif,
              // Only AUTO attaches anything. On OFF - the default - nothing
              // protective exists until it is dragged off the position marker.
              bracket,
            }),
        ),
      );
    },
    [accountId, defaults, instrument, limitPrice, qty, run, stopPrice, type],
  );

  /**
   * A press on BUY or SELL.
   *
   * With confirmation off - the default - this IS the order: one press, one
   * order, no dialog. With it on, the first press arms that side and the
   * second sends it.
   *
   * `pressedAt` is the event's own timestamp, so the execution instrument
   * measures from the hardware event rather than from whenever React got
   * round to running this.
   */
  const press = useCallback(
    (side: 'BUY' | 'SELL', pressedAt: number) => {
      if (defaults.confirmOrders && armed !== side) {
        setArmed(side);
        return;
      }
      setArmed(null);
      submit(side, pressedAt);
    },
    [armed, defaults.confirmOrders, submit],
  );

  if (!instrument) return <div className="tk-empty">No instrument selected.</div>;

  const needsLimit = type === 'LIMIT' || type === 'STOP_LIMIT';
  const needsStop = type === 'STOP_MARKET' || type === 'STOP_LIMIT';
  const ready = Boolean(accountId) && !busy;

  return (
    <div className="tk" data-testid="order-ticket">
      {/*
        WHAT IS ABOUT TO BE TRADED, AND WHOSE MONEY - on one line.

        The account is in the account bar too, at the other end of a 1600px
        window; a trader about to press BUY is looking HERE, and "which
        account was I on?" is not a question worth a glance across the screen
        for someone running several. But it does not get a row of its own:
        it shares the row the contract already had, which costs the ticket
        nothing and puts both answers in one glance.
      */}
      <div className="tk-head" data-testid="ticket-account" title={account?.name ?? ''}>
        <span className="tk-head-account">{account?.name ?? 'No account'}</span>
        <span className="tk-head-contract">
          <span className="num">{instrument.activeContract.code}</span>
          <span className="tk-contract-root">{instrument.root}</span>
        </span>
      </div>

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
          className={`tk-buy ${armed === 'BUY' ? 'tk-armed' : ''}`}
          disabled={!ready || !canTrade}
          onClick={(event) => press('BUY', event.timeStamp)}
          data-testid="buy"
        >
          {armed === 'BUY' ? 'CONFIRM BUY' : 'BUY'} <b>{qty}</b>
        </button>
        <button
          className={`tk-sell ${armed === 'SELL' ? 'tk-armed' : ''}`}
          disabled={!ready || !canTrade}
          onClick={(event) => press('SELL', event.timeStamp)}
          data-testid="sell"
        >
          {armed === 'SELL' ? 'CONFIRM SELL' : 'SELL'} <b>{qty}</b>
        </button>
      </div>

      {/*
        MANAGING what is already on, which is a different job from opening it.
        
        It appears only when there is a position, because a row of controls
        that do nothing most of the time is furniture. Break even moves the
        stop to the average entry the SERVER reports; the percentages reduce
        the position by whole contracts.
      */}
      {position ? (
        <div className="tk-manage" data-testid="ticket-manage">
          <button
            className="tk-manage-btn"
            disabled={!ready || !canTrade}
            title={
              defaults.breakEvenIncludesFees
                ? 'Move the stop to the average entry plus the round turn'
                : 'Move the stop to the average entry'
            }
            data-testid="break-even"
            onClick={() => {
              const price = breakEvenPrice(
                position,
                instrument.tickSize,
                instrument.tickValueMicros,
                (instrument.commissionPerSideMicros + instrument.exchangeFeesPerSideMicros) * 2,
                defaults.breakEvenIncludesFees,
              );
              if (price === null) return;
              void run(() => tradingApi.protect(accountId!, instrument.root, { stopPrice: price }));
            }}
          >
            BE
          </button>
          {[0.25, 0.5, 0.75].map((fraction) => {
            const size = partialQty(position.qty, fraction);
            return (
              <button
                key={fraction}
                className="tk-manage-btn"
                disabled={!ready || !canTrade || size === 0}
                data-testid={`partial-${Math.round(fraction * 100)}`}
                title={
                  size === 0
                    ? 'A one-lot has no partial: closing it is closing the position'
                    : `Close ${size} of ${position.qty}`
                }
                onClick={() => {
                  if (size === 0) return;
                  const side = position.side === 'LONG' ? 'SELL' : 'BUY';
                  const intent = `partial:${accountId}:${instrument.root}:${fraction}:${position.qty}`;
                  void run(() =>
                    sendIntent(
                      {
                        intent,
                        label: `Close ${size} ${instrument.root}`,
                        accountId: accountId!,
                        symbol: instrument.root,
                        prefix: 'partial',
                      },
                      (clientOrderId) =>
                        tradingApi.submit({
                          accountId: accountId!,
                          clientOrderId,
                          symbol: instrument.root,
                          side,
                          qty: size,
                          type: 'MARKET',
                          tif: 'DAY',
                          bracket: null,
                        }),
                    ),
                  );
                }}
              >
                {Math.round(fraction * 100)}%
              </button>
            );
          })}
        </div>
      ) : null}

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

      {pending.length > 0 ? (
        <div className="tk-pending" data-testid="ticket-pending">
          <span className="tk-pending-dot" aria-hidden="true" />
          {pending.map((f) => f.label).join(', ')} — sending
        </div>
      ) : null}

      {error ? (
        <div className="tk-error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
