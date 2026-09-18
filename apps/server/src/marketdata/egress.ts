/**
 * Does this process have a route to the market-data vendor?
 *
 * A deployment behind an egress proxy - which is most of them, and this
 * development environment - only reaches the outside world through it. Node's
 * `fetch` ignores `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY` is set, and the
 * failure mode when it is not set is the worst kind: every request takes
 * fifteen seconds and comes back `503 upstream connect error`, the provider
 * reports RECONNECTING, and the chart quietly shows the last price it managed
 * to get. It looked exactly like a slow feed for as long as it took to compare
 * a `curl` (200 in 0.3s) against the same URL from Node (503 in 15s).
 *
 * So it is checked at start-up and said out loud. A market-data feed that
 * cannot reach its vendor must never be a mystery.
 */

/** Proxy variables an operator might reasonably have set. */
const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'] as const;

export interface EgressCheck {
  readonly proxyConfigured: string | null;
  readonly nodeWillUseIt: boolean;
  /** Set when the two disagree, which is the broken combination. */
  readonly warning: string | null;
}

export function checkEgress(environment: NodeJS.ProcessEnv = process.env): EgressCheck {
  const found = PROXY_VARS.map((v) => environment[v]).find((v) => v && v.length > 0) ?? null;
  const flag = environment['NODE_USE_ENV_PROXY'];
  const nodeWillUseIt = flag === '1' || flag === 'true';

  if (found && !nodeWillUseIt) {
    return {
      proxyConfigured: found,
      nodeWillUseIt: false,
      warning:
        `An egress proxy is configured (${found}) but NODE_USE_ENV_PROXY is not set, ` +
        "so this process's fetch() will bypass it and every market-data request will " +
        'fail with 503 after a long timeout. Start the server with NODE_USE_ENV_PROXY=1.',
    };
  }
  return { proxyConfigured: found, nodeWillUseIt, warning: null };
}

/** Log the check once, loudly enough to be noticed. */
export function reportEgress(check: EgressCheck = checkEgress()): void {
  if (check.warning) console.error(`[market-data] ${check.warning}`);
}
