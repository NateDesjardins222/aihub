/**
 * Phase 4 — the Design Lab is a development-only surface (tests 16/17).
 *
 * `designLabEnabled()` gates on the Vite build mode. In a production build
 * (`MODE==='production'`) it is false, so /design-lab is inert even via direct URL;
 * in development it is available.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { designLabEnabled, isDevBuild } from './runtime';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('designLabEnabled', () => {
  it('is DISABLED in a production build', () => {
    vi.stubEnv('MODE', 'production');
    expect(isDevBuild()).toBe(false);
    expect(designLabEnabled()).toBe(false);
  });
  it('is ENABLED in a development build', () => {
    vi.stubEnv('MODE', 'development');
    expect(isDevBuild()).toBe(true);
    expect(designLabEnabled()).toBe(true);
  });
});
