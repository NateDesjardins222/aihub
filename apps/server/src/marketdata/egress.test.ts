import { describe, expect, it } from 'vitest';
import { checkEgress } from './egress.js';

describe('egress check', () => {
  it('warns when a proxy is configured and Node will ignore it', () => {
    const check = checkEgress({ HTTPS_PROXY: 'http://127.0.0.1:34219' });
    expect(check.proxyConfigured).toBe('http://127.0.0.1:34219');
    expect(check.nodeWillUseIt).toBe(false);
    expect(check.warning).toMatch(/NODE_USE_ENV_PROXY/);
  });

  it('is quiet when the proxy will be used', () => {
    const check = checkEgress({ HTTPS_PROXY: 'http://127.0.0.1:34219', NODE_USE_ENV_PROXY: '1' });
    expect(check.nodeWillUseIt).toBe(true);
    expect(check.warning).toBeNull();
  });

  it('is quiet when there is no proxy at all', () => {
    expect(checkEgress({}).warning).toBeNull();
  });

  it('accepts the lowercase variables an operator may have set', () => {
    expect(checkEgress({ https_proxy: 'http://p:1' }).proxyConfigured).toBe('http://p:1');
    expect(checkEgress({ http_proxy: 'http://p:1' }).proxyConfigured).toBe('http://p:1');
  });

  it('treats "true" as set, because operators write that', () => {
    expect(checkEgress({ HTTPS_PROXY: 'http://p:1', NODE_USE_ENV_PROXY: 'true' }).warning).toBeNull();
  });
});
