/**
 * Rithmic configuration + redaction (M4-D).
 *
 * ONE place reads Rithmic settings from server-side configuration. Credentials
 * are read here and NEVER logged, returned from an API, sent to the browser, or
 * placed in an error. When settings are incomplete the provider is UNCONFIGURED
 * — it does not fake a connection and does not fail the process.
 *
 * There is NO real R | Protocol wire integration in this file: connecting needs
 * the official Rithmic dev kit / protocol spec, credentials, a broker/FCM
 * relationship and conformance (see docs/rithmic-integration-readiness-v1.md).
 * This module only validates presence and shape.
 */
import { env } from '../config/env.js';
import type { ProviderConfigState } from '@atlas/contracts';

export interface RithmicConfig {
  readonly environment: 'test' | 'paper' | 'live';
  readonly gateway: string;
  readonly system: string;
  readonly user: string;
  /** Present but NEVER exposed. Held only to hand to the (future) dev kit. */
  readonly password: string;
  readonly fcmId: string;
  readonly ibId: string;
  readonly appName: string;
  readonly appVersion: string;
}

export type RithmicConfigResult =
  | { readonly state: 'CONFIGURED'; readonly config: RithmicConfig }
  | { readonly state: 'UNCONFIGURED'; readonly missing: readonly string[] };

/**
 * Resolve Rithmic config from the environment. Returns UNCONFIGURED (with the
 * list of missing keys — names only, never values) when anything required is
 * absent. Never throws.
 */
export function resolveRithmicConfig(): RithmicConfigResult {
  const e = env();
  const required: Record<string, string | undefined> = {
    RITHMIC_ENV: e.RITHMIC_ENV,
    RITHMIC_GATEWAY: e.RITHMIC_GATEWAY,
    RITHMIC_SYSTEM: e.RITHMIC_SYSTEM,
    RITHMIC_USER: e.RITHMIC_USER,
    RITHMIC_PASSWORD: e.RITHMIC_PASSWORD,
    RITHMIC_FCM_ID: e.RITHMIC_FCM_ID,
    RITHMIC_IB_ID: e.RITHMIC_IB_ID,
  };
  const missing = Object.entries(required)
    .filter(([, v]) => !v || v.trim() === '')
    .map(([k]) => k);
  if (missing.length > 0) return { state: 'UNCONFIGURED', missing };

  return {
    state: 'CONFIGURED',
    config: {
      environment: e.RITHMIC_ENV!,
      gateway: e.RITHMIC_GATEWAY!,
      system: e.RITHMIC_SYSTEM!,
      user: e.RITHMIC_USER!,
      password: e.RITHMIC_PASSWORD!,
      fcmId: e.RITHMIC_FCM_ID!,
      ibId: e.RITHMIC_IB_ID!,
      appName: e.RITHMIC_APP_NAME ?? 'Atlas',
      appVersion: e.RITHMIC_APP_VERSION ?? '0.0.0',
    },
  };
}

export function rithmicConfigState(): ProviderConfigState {
  return resolveRithmicConfig().state === 'CONFIGURED' ? 'CONFIGURED' : 'UNCONFIGURED';
}

/** The M9 wire-connection configuration, assembled from env. Never exposes secrets. */
export interface RithmicConnection {
  readonly enabled: boolean;
  readonly marketDataEnabled: boolean;
  readonly executionEnabled: boolean;
  readonly environment: 'TEST' | 'PAPER' | 'LIVE';
  readonly endpoint: string;
  readonly systemName: string;
  readonly appName: string;
  readonly appVersion: string;
  readonly vendorDir: string | null;
  /** Present only when credentials are fully configured; NEVER logged/returned. */
  readonly credentials: { user: string; password: string } | null;
}

export type RithmicConnectionResult =
  | { readonly ok: true; readonly connection: RithmicConnection }
  | { readonly ok: false; readonly reason: string; readonly missing: readonly string[] };

/**
 * Resolve the M9 connection config. Fails (ok:false) with a name-only reason when
 * enabled but incomplete, so an operator sees exactly what is missing without any
 * secret being surfaced. `credentials` is null until user+password are present.
 */
export function resolveRithmicConnection(): RithmicConnectionResult {
  const e = env();
  const enabled = e.RITHMIC_ENABLED === true;
  const missing: string[] = [];
  const endpoint = e.RITHMIC_ENDPOINT ?? '';
  const systemName = e.RITHMIC_SYSTEM_NAME ?? e.RITHMIC_SYSTEM ?? '';
  if (!endpoint) missing.push('RITHMIC_ENDPOINT');
  if (!systemName) missing.push('RITHMIC_SYSTEM_NAME');
  if (!e.RITHMIC_USER || e.RITHMIC_USER.trim() === '') missing.push('RITHMIC_USER');
  if (!e.RITHMIC_PASSWORD || e.RITHMIC_PASSWORD.trim() === '') missing.push('RITHMIC_PASSWORD');
  const credentials = e.RITHMIC_USER && e.RITHMIC_PASSWORD ? { user: e.RITHMIC_USER, password: e.RITHMIC_PASSWORD } : null;
  if (!enabled) return { ok: false, reason: 'RITHMIC_ENABLED is false', missing: ['RITHMIC_ENABLED'] };
  if (missing.length > 0) return { ok: false, reason: `missing: ${missing.join(', ')}`, missing };
  return {
    ok: true,
    connection: {
      enabled,
      marketDataEnabled: e.RITHMIC_MARKET_DATA_ENABLED === true,
      executionEnabled: e.RITHMIC_EXECUTION_ENABLED === true,
      environment: e.RITHMIC_ENVIRONMENT,
      endpoint, systemName,
      appName: e.RITHMIC_APP_NAME ?? 'Atlas',
      appVersion: e.RITHMIC_APP_VERSION ?? '9.0.0',
      vendorDir: e.RITHMIC_VENDOR_DIR ?? null,
      credentials,
    },
  };
}

/**
 * A redacted, secret-free description of the Rithmic config for owner/ops
 * surfaces. Shows the environment, gateway host, system and whether credentials
 * are present — NEVER the user, password, or ids.
 */
export function redactedRithmicDescription(): string {
  const r = resolveRithmicConfig();
  if (r.state === 'UNCONFIGURED') {
    return `UNCONFIGURED (missing: ${r.missing.join(', ')})`;
  }
  return `env=${r.config.environment} gateway=${r.config.gateway} system=${r.config.system} credentials=present`;
}
