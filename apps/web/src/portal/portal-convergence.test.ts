/**
 * Portal Convergence Phase 1 — structural proofs.
 *
 * One canonical customer product at `/portal`: the approved V2 experience backed by
 * the hardened core. These are deterministic SOURCE-level invariants (no DB, no
 * browser) that stop the two-portal split from ever coming back:
 *  - `/portal` mounts PortalV2App (V2 shell), NOT the rejected V1 PortalApp.
 *  - the canonical production portal imports NO dev fixtures (fixture firewall).
 *  - `/portal-v2` stays DEV-gated (never a second production product).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_SRC = join(HERE, '..'); // apps/web/src
const read = (rel: string): string => readFileSync(join(WEB_SRC, rel), 'utf8');

describe('Portal convergence — one canonical /portal product', () => {
  it('App.tsx mounts PortalV2App at /portal (the approved V2 experience), not the V1 shell', () => {
    const app = read('App.tsx');
    // The /portal lazy route resolves to the canonical V2 app.
    expect(app).toMatch(/import\(['"]\.\/portal\/PortalV2App['"]\)/);
    // The rejected V1 shell is no longer the /portal runtime import.
    expect(app).not.toMatch(/import\(['"]\.\/portal\/PortalApp['"]\)/);
  });

  it('the canonical portal is the V2 sidebar shell, not the rejected horizontal nav', () => {
    const appV2 = read('portal/PortalV2App.tsx');
    expect(appV2).toMatch(/V2AppShell/);
    // It must not re-introduce the V1 horizontal-nav shell component.
    expect(appV2).not.toMatch(/from ['"]\.\/PortalApp['"]/);
  });

  it('FIXTURE FIREWALL: the canonical production portal imports no dev fixtures', () => {
    const prod = ['portal/PortalV2App.tsx', 'portal/v2/containers.tsx', 'portal/v2/dashboard.tsx'];
    for (const f of prod) {
      const src = read(f);
      expect(src, `${f} must not import fixtures`).not.toMatch(/['"]\.\.?\/.*fixtures['"]/);
      expect(src, `${f} must not import cert-samples`).not.toMatch(/cert-samples/);
      expect(src, `${f} must not import the dev Review harness`).not.toMatch(/['"]\.\/v2\/Review['"]|\/Review['"]/);
    }
  });

  it('the canonical portal data containers read authoritative /api/v1 endpoints only', () => {
    const c = read('portal/v2/containers.tsx');
    expect(c).toMatch(/\/api\/v1\/portal\/accounts/);
    // No fixture symbols leaked into the container layer.
    expect(c).not.toMatch(/FIXTURE_/);
  });

  it('/portal-v2 remains DEV-gated (never a second production product)', () => {
    const app = read('App.tsx');
    // The /portal-v2 branch is guarded by the dev/design-lab gate.
    expect(app).toMatch(/designLabEnabled\(\)/);
    expect(app).toMatch(/portal-v2/);
  });

  it('Add Account routes to the canonical purchase flow, never a client-side account create', () => {
    const appV2 = read('portal/PortalV2App.tsx');
    expect(appV2).toMatch(/\/onboarding/);
    // The hand-off preserves §4A (publicId to Atlas; server re-checks ownership).
    expect(appV2).toMatch(/\/\?account=\$\{publicId\}/);
  });
});
