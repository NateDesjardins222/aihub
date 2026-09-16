/**
 * /api/v1/instruments
 *
 * The client renders order tickets, DOM ladders and risk read-outs from these
 * values. It never carries its own copy of a tick size.
 */
import type { FastifyInstance } from 'fastify';
import {
  getMarketState,
  listInstruments,
  requireInstrument,
  resolveActiveContract,
  tickSize,
  ticksPerPoint,
} from '@atlas/instruments';
import { ApiError } from '../errors.js';

function present(root: string, asOf: number) {
  const spec = requireInstrument(root);
  const active = resolveActiveContract(spec, asOf);
  const market = getMarketState(spec, asOf);
  return {
    root: spec.root,
    displayName: spec.displayName,
    description: spec.description,
    exchange: spec.exchange,
    assetClass: spec.assetClass,
    currency: spec.currency,
    pricePrecision: spec.pricePrecision,
    tickSize: tickSize(spec),
    tickSizeScaled: spec.tickSizeScaled,
    ticksPerPoint: ticksPerPoint(spec),
    tickValueMicros: spec.tickValueMicros,
    pointValueMicros: spec.pointValueMicros,
    contractMultiplier: spec.contractMultiplier,
    sessionTimezone: spec.sessionTimezone,
    sessionLabel: spec.sessionLabel,
    regularHours: spec.regularHours,
    maintenanceWindows: spec.maintenanceWindows,
    supportedOrderTypes: spec.supportedOrderTypes,
    commissionPerSideMicros: spec.commissionPerSideMicros,
    exchangeFeesPerSideMicros: spec.exchangeFeesPerSideMicros,
    minOrderQty: spec.minOrderQty,
    maxOrderQty: spec.maxOrderQty,
    isMicro: spec.isMicro,
    fullSizeRoot: spec.fullSizeRoot ?? null,
    activeContract: active,
    marketState: market,
  };
}

export async function instrumentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (_request, reply) => {
    const asOf = Date.now();
    return reply.send({ instruments: listInstruments().map((i) => present(i.root, asOf)) });
  });

  app.get<{ Params: { root: string } }>('/:root', async (request, reply) => {
    const root = request.params.root.toUpperCase();
    try {
      return reply.send(present(root, Date.now()));
    } catch {
      throw ApiError.notFound('UNKNOWN_INSTRUMENT', `No instrument named ${root}.`);
    }
  });
}
