/**
 * Rithmic PNL-plant service (Milestone 9).
 *
 * Subscribes to position + P&L updates and normalizes them into provider-side
 * snapshots. These are Rithmic's view — they are NEVER used to overwrite Happy
 * Trader's authoritative prop-firm ledger; the reconciliation layer surfaces
 * differences instead.
 */
import type { ExternalPositionSnapshot } from '../../execution/external-provider.js';
import type { RithmicPlant } from './plant.js';
import { rithmicCodec, type RithmicCodec } from '../protocol/codec.js';

export interface RithmicPnl {
  readonly accountId: string;
  readonly openPnl: number;
  readonly closedPnl: number;
  readonly dayPnl: number;
  readonly at: number;
}

export class RithmicPnlService {
  private readonly codec: RithmicCodec;
  private readonly positions = new Map<string, ExternalPositionSnapshot>(); // symbol -> snapshot
  private accountPnl: RithmicPnl | null = null;
  private routerUnsub: Array<() => void> = [];

  constructor(private plant: RithmicPlant) {
    this.codec = rithmicCodec();
    this.routerUnsub = [
      plant.router.on('InstrumentPnLPositionUpdate', (m) => this.onInstrument(m.message)),
      plant.router.on('AccountPnLPositionUpdate', (m) => this.onAccount(m.message)),
    ];
  }

  async subscribe(account: { fcmId: string; ibId: string; accountId: string }): Promise<void> {
    const req = this.codec.enumValue('RequestPnLPositionUpdates', 'Request', 'SUBSCRIBE');
    this.plant.send('RequestPnLPositionUpdates', { request: req, fcm_id: account.fcmId, ib_id: account.ibId, account_id: account.accountId, user_msg: ['pnl'] });
  }

  private onInstrument(msg: Record<string, unknown> | null): void {
    if (!msg) return;
    const symbol = String(msg['symbol'] ?? '');
    if (!symbol) return;
    const netQty = num(msg['net_quantity']) ?? 0;
    if (netQty === 0) { this.positions.delete(symbol); return; }
    this.positions.set(symbol, {
      symbol,
      contractCode: symbol,
      netQty,
      avgPrice: num(msg['avg_open_fill_price']),
    });
  }

  private onAccount(msg: Record<string, unknown> | null): void {
    if (!msg) return;
    this.accountPnl = {
      accountId: String(msg['account_id'] ?? ''),
      openPnl: num(msg['open_position_pnl']) ?? 0,
      closedPnl: num(msg['closed_position_pnl']) ?? 0,
      dayPnl: num(msg['day_pnl']) ?? 0,
      at: Date.now(),
    };
  }

  listPositions(): ExternalPositionSnapshot[] { return [...this.positions.values()]; }
  getAccountPnl(): RithmicPnl | null { return this.accountPnl; }

  dispose(): void {
    this.routerUnsub.forEach((u) => u());
    this.routerUnsub = [];
  }
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== null && v !== '' ? n : null;
}
