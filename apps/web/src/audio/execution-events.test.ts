/**
 * What Atlas is allowed to say out loud.
 *
 * The rule these tests exist to protect is the one a trader's trust rests on:
 * a sound means the SERVER did something. Nothing here has a click in it,
 * because the decision has no access to one.
 */
import { describe, expect, it } from 'vitest';
import { EMPTY_SNAPSHOT, snapshotOf, soundsFor } from './execution-events';
import type { ApiOrder, ApiPosition } from '../trading/api';

const order = (patch: Partial<ApiOrder>): ApiOrder =>
  ({
    id: 'o1',
    accountId: 'a1',
    clientOrderId: 'c1',
    symbol: 'NQ',
    side: 'BUY',
    qty: 1,
    filledQty: 0,
    remainingQty: 1,
    type: 'MARKET',
    limitTicks: null,
    stopTicks: null,
    limitPrice: null,
    stopPrice: null,
    tif: 'DAY',
    status: 'WORKING',
    stopTriggered: false,
    avgFillPrice: null,
    ocoGroupId: null,
    bracketRole: 'STANDALONE',
    trailTicks: null,
    rejectReason: null,
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  }) as ApiOrder;

const position = (patch: Partial<ApiPosition>): ApiPosition =>
  ({
    symbol: 'NQ',
    side: 'LONG',
    qty: 1,
    signedQty: 1,
    avgEntryPrice: 100,
    markPrice: 100,
    unrealizedPnlMicros: 0,
    realizedPnlMicros: 0,
    feesMicros: 0,
    openedAt: 0,
    stopOrderId: null,
    targetOrderId: null,
    ...patch,
  }) as ApiPosition;

describe('soundsFor', () => {
  it('says nothing on the first authoritative read', () => {
    // A reload, or an account just selected: everything in this snapshot
    // already happened, possibly hours ago.
    const sounds = soundsFor(
      EMPTY_SNAPSHOT,
      [order({ status: 'FILLED' })],
      [position({ qty: 0, side: 'FLAT' })],
    );
    expect(sounds).toEqual([]);
  });

  it('announces an order that reached FILLED', () => {
    const before = snapshotOf([order({ status: 'WORKING' })], [position({ qty: 0, side: 'FLAT' })]);
    expect(soundsFor(before, [order({ status: 'FILLED' })], [position({ qty: 1 })])).toEqual([
      'ORDER_FILLED',
    ]);
  });

  it('says nothing while an order is only partly filled', () => {
    const before = snapshotOf([order({ status: 'WORKING' })], []);
    const sounds = soundsFor(
      before,
      [order({ status: 'PARTIALLY_FILLED', filledQty: 4, remainingQty: 6 })],
      [position({ qty: 4 })],
    );
    expect(sounds).toEqual([]);
  });

  it('announces a ten-lot filling in four pieces exactly once', () => {
    let snapshot = snapshotOf([order({ status: 'WORKING', qty: 10 })], []);
    const heard: string[] = [];
    for (const [filled, status] of [
      [2, 'PARTIALLY_FILLED'],
      [5, 'PARTIALLY_FILLED'],
      [9, 'PARTIALLY_FILLED'],
      [10, 'FILLED'],
    ] as const) {
      const orders = [order({ status, qty: 10, filledQty: filled, remainingQty: 10 - filled })];
      const positions = [position({ qty: filled })];
      heard.push(...soundsFor(snapshot, orders, positions));
      snapshot = snapshotOf(orders, positions);
    }
    expect(heard).toEqual(['ORDER_FILLED']);
  });

  it('names the protective leg rather than calling it an order', () => {
    const before = snapshotOf(
      [order({ id: 'sl', status: 'WORKING', bracketRole: 'STOP_LOSS' })],
      [position({ qty: 1 })],
    );
    const sounds = soundsFor(
      before,
      [order({ id: 'sl', status: 'FILLED', bracketRole: 'STOP_LOSS' })],
      [position({ qty: 0, side: 'FLAT' })],
    );
    // One event to a trader: the stop is the specific truth, and it already
    // says the position is gone.
    expect(sounds).toEqual(['STOP_FILLED']);
  });

  it('does the same for a target', () => {
    const before = snapshotOf(
      [order({ id: 'tp', status: 'WORKING', bracketRole: 'TAKE_PROFIT' })],
      [position({ qty: 2 })],
    );
    expect(
      soundsFor(
        before,
        [order({ id: 'tp', status: 'FILLED', bracketRole: 'TAKE_PROFIT' })],
        [position({ qty: 0, side: 'FLAT' })],
      ),
    ).toEqual(['TARGET_FILLED']);
  });

  it('announces a flatten once, not as a fill and a close', () => {
    const before = snapshotOf(
      [order({ id: 'x', status: 'WORKING' })],
      [position({ qty: 3 })],
    );
    expect(
      soundsFor(before, [order({ id: 'x', status: 'FILLED' })], [position({ qty: 0, side: 'FLAT' })]),
    ).toEqual(['POSITION_CLOSED']);
  });

  it('says nothing when a position merely gets smaller', () => {
    const before = snapshotOf([], [position({ qty: 5 })]);
    expect(soundsFor(before, [], [position({ qty: 2 })])).toEqual([]);
  });

  it('treats a position that vanished from the list as closed', () => {
    const before = snapshotOf([], [position({ qty: 1 })]);
    expect(soundsFor(before, [], [])).toEqual(['POSITION_CLOSED']);
  });

  it('announces a rejection', () => {
    const before = snapshotOf([order({ status: 'WORKING' })], []);
    expect(soundsFor(before, [order({ status: 'REJECTED' })], [])).toEqual(['ORDER_REJECTED']);
  });

  it('does not announce an order it has never seen before', () => {
    // A fill that happened while this tab was closed belongs to the blotter,
    // not to the speaker.
    const before = snapshotOf([order({ id: 'known', status: 'WORKING' })], []);
    const sounds = soundsFor(
      before,
      [order({ id: 'known', status: 'WORKING' }), order({ id: 'older', status: 'FILLED' })],
      [],
    );
    expect(sounds).toEqual([]);
  });
});
