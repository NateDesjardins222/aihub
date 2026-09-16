/**
 * Zod schemas shared by the HTTP layer, the WS layer and the client.
 * One definition; validation cannot drift between transport and consumer.
 */
import { z } from 'zod';

export const timeframeSchema = z.enum([
  '1s', '5s', '10s', '15s', '30s',
  '1m', '2m', '3m', '5m', '10m', '15m', '30m',
  '1h', '2h', '4h',
  '1D', '1W', '1M',
]);

export const sideSchema = z.enum(['BUY', 'SELL']);
export const orderTypeSchema = z.enum(['MARKET', 'LIMIT', 'STOP_MARKET', 'STOP_LIMIT', 'TRAILING_STOP']);
export const tifSchema = z.enum(['DAY', 'GTC', 'IOC', 'FOK']);

/** Bracket offsets may be expressed in ticks, points or dollars; server resolves to ticks. */
export const bracketOffsetSchema = z.object({
  unit: z.enum(['TICKS', 'POINTS', 'DOLLARS']),
  value: z.number().positive(),
});

export const bracketRequestSchema = z.object({
  stopLoss: bracketOffsetSchema.nullish(),
  takeProfit: bracketOffsetSchema.nullish(),
  trailingStop: bracketOffsetSchema.nullish(),
});

export const orderRequestSchema = z
  .object({
    accountId: z.string().min(1),
    clientOrderId: z.string().min(8).max(128),
    symbol: z.string().min(1).max(12),
    side: sideSchema,
    qty: z.number().int().positive().max(1000),
    type: orderTypeSchema,
    /** Human-facing decimal prices. The server snaps and converts them to ticks. */
    limitPrice: z.number().finite().nullish(),
    stopPrice: z.number().finite().nullish(),
    tif: tifSchema.default('DAY'),
    trailTicks: z.number().int().positive().nullish(),
    bracket: bracketRequestSchema.nullish(),
  })
  .superRefine((v, ctx) => {
    if ((v.type === 'LIMIT' || v.type === 'STOP_LIMIT') && v.limitPrice == null) {
      ctx.addIssue({ code: 'custom', path: ['limitPrice'], message: 'MISSING_LIMIT_PRICE' });
    }
    if ((v.type === 'STOP_MARKET' || v.type === 'STOP_LIMIT') && v.stopPrice == null) {
      ctx.addIssue({ code: 'custom', path: ['stopPrice'], message: 'MISSING_STOP_PRICE' });
    }
    if (v.type === 'TRAILING_STOP' && v.trailTicks == null) {
      ctx.addIssue({ code: 'custom', path: ['trailTicks'], message: 'MISSING_TRAIL_DISTANCE' });
    }
  });

export const orderModifySchema = z.object({
  qty: z.number().int().positive().max(1000).optional(),
  limitPrice: z.number().finite().nullish(),
  stopPrice: z.number().finite().nullish(),
  trailTicks: z.number().int().positive().nullish(),
  expectedVersion: z.number().int().nonnegative().optional(),
});

export const registerSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(10).max(200),
  displayName: z.string().min(1).max(60),
});

export const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
});

export const historicalBarsQuerySchema = z.object({
  symbol: z.string().min(1).max(12),
  timeframe: timeframeSchema,
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().positive().max(20000).optional(),
});

export const drawingSchema = z.object({
  id: z.string().min(1).max(64),
  chartId: z.string().min(1).max(64),
  symbol: z.string().min(1).max(12),
  tool: z.string().min(1).max(48),
  points: z.array(z.object({ time: z.number(), price: z.number() })).max(64),
  style: z.record(z.string(), z.unknown()).default({}),
  meta: z.record(z.string(), z.unknown()).default({}),
  zIndex: z.number().int().default(0),
  locked: z.boolean().default(false),
  hidden: z.boolean().default(false),
  timeframeVisibility: z.array(timeframeSchema).nullish(),
});

export const indicatorSchema = z.object({
  id: z.string().min(1).max(64),
  chartId: z.string().min(1).max(64),
  type: z.string().min(1).max(48),
  inputs: z.record(z.string(), z.unknown()).default({}),
  style: z.record(z.string(), z.unknown()).default({}),
  pane: z.number().int().min(0).max(8).default(0),
  orderIndex: z.number().int().default(0),
  visible: z.boolean().default(true),
});

export const layoutSchema = z.object({
  name: z.string().min(1).max(80),
  config: z.record(z.string(), z.unknown()),
  isDefault: z.boolean().optional(),
});

export type OrderRequestInput = z.infer<typeof orderRequestSchema>;
export type OrderModifyInput = z.infer<typeof orderModifySchema>;
export type BracketRequestInput = z.infer<typeof bracketRequestSchema>;
export type DrawingInput = z.infer<typeof drawingSchema>;
export type IndicatorInput = z.infer<typeof indicatorSchema>;
