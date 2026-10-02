/**
 * The authoritative Whop ↔ Happy Trader product mapping — ONE place, both directions.
 *
 * A Whop purchase must resolve to exactly one immutable internal product, and it
 * must do so deterministically by a STABLE Whop identifier (the plan id) — never by
 * display name, description, price, or URL slug (§7/§13/§14 of the Whop phase spec).
 *
 * The mapping lives in configuration, not code: the `WHOP_PLAN_MAP` env var is a
 * JSON object `{ "<internal product key>": "<Whop plan id>" }`. The CORE 50K canary
 * is a single entry; adding the other nine products is extending this JSON. The
 * product's own `config.whopPlanId` is a per-product fallback (the product model
 * seeds a deterministic PLACEHOLDER there, so the env map is what carries the REAL
 * Whop plan ids Nathan creates in the Whop dashboard).
 *
 * This module holds no secret and talks to no provider. It is pure, cached config
 * resolution, so both the checkout entry and the webhook cross-check read the same
 * source of truth.
 */
import { env } from '../config/env.js';

export class WhopPlanMapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WhopPlanMapError';
  }
}

export type WhopPlanMap = Readonly<Record<string, string>>;

let cache: { raw: string | undefined; map: WhopPlanMap } | null = null;

/**
 * Parse and cache `WHOP_PLAN_MAP`. A malformed value is a hard error (surfaced at
 * first use / startup validation) rather than a silent empty map — mismapping money
 * is the one thing we never want to do quietly. An unset value is a valid empty map.
 */
export function whopPlanMap(): WhopPlanMap {
  const raw = env().WHOP_PLAN_MAP;
  if (cache && cache.raw === raw) return cache.map;
  const map = parseWhopPlanMap(raw);
  cache = { raw, map };
  return map;
}

/** Test-only: drop the memoised parse so a changed env var is re-read. */
export function resetWhopPlanMapCache(): void {
  cache = null;
}

/**
 * Parse a raw `WHOP_PLAN_MAP` JSON string into a validated map. Exported so the
 * parser can be unit-tested directly without env plumbing. A malformed value
 * throws `WhopPlanMapError`; an empty/undefined value is a valid empty map.
 */
export function parseWhopPlanMap(raw: string | undefined): WhopPlanMap {
  if (!raw || raw.trim() === '') return Object.freeze({});
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WhopPlanMapError('WHOP_PLAN_MAP is not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new WhopPlanMapError('WHOP_PLAN_MAP must be a JSON object of productKey → whopPlanId.');
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new WhopPlanMapError(`WHOP_PLAN_MAP entry "${key}" must map to a non-empty Whop plan id string.`);
    }
    out[key] = value;
  }
  return Object.freeze(out);
}

/**
 * The Whop plan id a given Happy Trader product is sold as, or null when the
 * product has no mapping (checkout then reports not-configured rather than guessing).
 *
 * Precedence: the explicit `WHOP_PLAN_MAP` entry (the real plan id) wins over the
 * product config's `whopPlanId` (the seeded placeholder / per-product value).
 */
export function whopPlanForProduct(
  productKey: string,
  configWhopPlanId: string | null,
  map: WhopPlanMap = whopPlanMap(),
): string | null {
  const explicit = map[productKey];
  if (explicit) return explicit;
  return configWhopPlanId ?? null;
}

/**
 * The internal product key a Whop plan id maps to, using the explicit map only.
 *
 * This is the reverse resolver a provider-INITIATED purchase would need (a Whop
 * webhook that carries only a plan id, no Atlas order). The canary is Atlas-
 * initiated (the order already names the product), so this is used for the webhook
 * cross-check's "is this plan known at all?" and for reconciliation — not to mint
 * identity. Returns null for an unmapped plan → the caller treats it as
 * `UNKNOWN_PRODUCT` and never provisions.
 */
export function productKeyForWhopPlan(planId: string, map: WhopPlanMap = whopPlanMap()): string | null {
  for (const [key, value] of Object.entries(map)) {
    if (value === planId) return key;
  }
  return null;
}

/** True when any explicit plan mapping is configured (owner/health display). */
export function whopPlanMapConfigured(): boolean {
  return Object.keys(whopPlanMap()).length > 0;
}
