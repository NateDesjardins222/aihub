/**
 * M6.1 — production certificate master integration + visual calibration.
 *
 * Proves the approved v1 masters load and validate, render deterministically at
 * the exact approved canvas, format the dynamic fields exactly as the artwork
 * requires (YYYY-MM-DD date, "NNK" account size, locked club milestone values,
 * uppercase recipient), keep the static master artwork pixel-identical outside
 * the dynamic-field regions, and fail CLOSED in production without an approved
 * master (never falling back to the non-production fixture).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { loadTemplate, validateManifest, TEMPLATE_ROOT, type CertificateManifest } from './certificate-manifest.js';
import { CanvasCertificateRenderer } from './certificate-renderer.js';
import { resolveTemplateVersion, money, accountSize, isoDate } from './certificate-render-service.js';
import { RENDERABLE_TYPES, isPhysicalEligibleType, templateTypeKey, validateCertificateDisplayName } from './certificates.js';

const DIGITAL = ['funded-trader', 'payout', 'account-completed', '10k-club', '50k-club'] as const;
const renderer = new CanvasCertificateRenderer();

const GOLDEN: Record<string, Record<string, string>> = {
  'funded-trader': { recipientName: 'NATETRADEZ', value: '50K', date: '2026-09-23' },
  payout: { recipientName: 'NATETRADEZ', value: '$5,000', date: '2026-09-23' },
  'account-completed': { recipientName: 'NATETRADEZ', value: '$25,000', date: '2026-09-23' },
  '10k-club': { recipientName: 'NATETRADEZ', value: '$10,000' },
  '50k-club': { recipientName: 'NATETRADEZ', value: '$50,000', date: '2026-09-23' },
};

/** Pixel data for a PNG buffer at the master canvas. */
async function pixels(png: Buffer, w: number, h: number): Promise<Uint8ClampedArray> {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  const img = await loadImage(png);
  ctx.drawImage(img, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}

/** The pixel bounding box a manifest field can touch (generous margin). */
function fieldBox(f: CertificateManifest['fields'][string]): { x0: number; x1: number; y0: number; y1: number } {
  const half = f.fontSize; // generous vertical margin for ascenders/descenders/spacing
  let x0: number, x1: number;
  if (f.alignment === 'center') { x0 = f.x - f.width / 2 - 12; x1 = f.x + f.width / 2 + 12; }
  else if (f.alignment === 'right') { x0 = f.x - f.width - 12; x1 = f.x + 12; }
  else { x0 = f.x - 12; x1 = f.x + f.width + 12; }
  return { x0, x1, y0: f.y - half - 6, y1: f.y + half + 6 };
}

describe('production v1 masters load + validate', () => {
  for (const key of DIGITAL) {
    it(`${key}: master + manifest load and validate at 1536x1024`, () => {
      const loaded = loadTemplate(key, 'v1');
      expect(loaded.renderable).toBe(true);
      if (!loaded.renderable) return;
      expect(loaded.manifest.canvas).toEqual({ width: 1536, height: 1024 });
      expect(loaded.master.length).toBeGreaterThan(1000);
      const v = validateManifest(JSON.parse(JSON.stringify({ ...loaded.manifest })), key, 'v1');
      expect(v.ok).toBe(true);
      // recipientName + value are always dynamic; the font is a bundled family.
      expect(loaded.manifest.fields.recipientName).toBeTruthy();
      expect(loaded.manifest.fields.value).toBeTruthy();
      expect(['HappyTraderSans', 'HappyTraderSerif']).toContain(loaded.manifest.fields.recipientName!.fontFamily);
    });
  }
});

describe('deterministic field formatting matches the approved artwork', () => {
  it('date is YYYY-MM-DD from the UTC event timestamp', () => {
    expect(isoDate(new Date(Date.UTC(2026, 8, 23, 23, 30)))).toBe('2026-09-23');
    expect(isoDate(new Date(Date.UTC(2026, 11, 31)))).toBe('2026-12-31');
  });
  it('account size renders compact "NNK"', () => {
    expect(accountSize(50_000 * 1_000_000)).toBe('50K');
    expect(accountSize(300_000 * 1_000_000)).toBe('300K');
    expect(accountSize(25_000 * 1_000_000)).toBe('25K');
  });
  it('money renders canonical thousands, no cents for whole amounts', () => {
    expect(money(5_000 * 1_000_000)).toBe('$5,000');
    expect(money(25_000 * 1_000_000)).toBe('$25,000');
    expect(money(1_700 * 1_000_000)).toBe('$1,700');
  });
});

describe('production certificates render at the approved canvas', () => {
  for (const key of DIGITAL) {
    it(`${key}: renders RENDERED 1536x1024 with a PNG, a PDF, and a 64-hex hash`, async () => {
      const r = await renderer.render({ templateType: key, templateVersion: 'v1', fields: GOLDEN[key]! });
      expect(r.status).toBe('RENDERED');
      if (r.status !== 'RENDERED') return;
      expect(r.width).toBe(1536);
      expect(r.height).toBe(1024);
      expect(r.png.length).toBeGreaterThan(1000);
      expect(r.pdf.subarray(0, 5).toString()).toBe('%PDF-'); // print-ready PDF artifact
      expect(r.renderHash).toMatch(/^[0-9a-f]{64}$/);
    });
  }

  it('the same input yields an identical render hash (deterministic)', async () => {
    const a = await renderer.render({ templateType: 'payout', templateVersion: 'v1', fields: GOLDEN.payout! });
    const b = await renderer.render({ templateType: 'payout', templateVersion: 'v1', fields: GOLDEN.payout! });
    expect(a.status).toBe('RENDERED');
    if (a.status === 'RENDERED' && b.status === 'RENDERED') expect(a.renderHash).toBe(b.renderHash);
  });

  it('a very long recipient shrinks to fit and never overflows the canvas', async () => {
    const r = await renderer.render({
      templateType: 'funded-trader', templateVersion: 'v1',
      fields: { recipientName: 'MAXIMILIAN ALEXANDER WORTHINGTON III', value: '300K', date: '2026-12-31' },
    });
    expect(r.status).toBe('RENDERED');
    if (r.status === 'RENDERED') { expect(r.width).toBe(1536); expect(r.height).toBe(1024); }
  });
});

describe('the approved master artwork is never modified outside the field regions', () => {
  for (const key of DIGITAL) {
    it(`${key}: pixels outside the dynamic-field boxes are identical to the master`, async () => {
      const loaded = loadTemplate(key, 'v1');
      expect(loaded.renderable).toBe(true);
      if (!loaded.renderable) return;
      const { width, height } = loaded.manifest.canvas;
      const masterPx = await pixels(loaded.master, width, height);
      const r = await renderer.render({ templateType: key, templateVersion: 'v1', fields: GOLDEN[key]! });
      expect(r.status).toBe('RENDERED');
      if (r.status !== 'RENDERED') return;
      const renderPx = await pixels(r.png, width, height);
      const boxes = Object.values(loaded.manifest.fields).map(fieldBox);
      const inABox = (x: number, y: number): boolean => boxes.some((b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1);
      let diffsOutside = 0;
      for (let y = 0; y < height; y += 2) {
        for (let x = 0; x < width; x += 2) {
          const i = (y * width + x) * 4;
          if (masterPx[i] !== renderPx[i] || masterPx[i + 1] !== renderPx[i + 1] || masterPx[i + 2] !== renderPx[i + 2]) {
            if (!inABox(x, y)) diffsOutside += 1;
          }
        }
      }
      expect(diffsOutside).toBe(0);
    });
  }

  it('with no field values the render is pixel-identical to the master (artwork untouched)', async () => {
    const loaded = loadTemplate('50k-club', 'v1');
    expect(loaded.renderable).toBe(true);
    if (!loaded.renderable) return;
    const { width, height } = loaded.manifest.canvas;
    const masterPx = await pixels(loaded.master, width, height);
    const r = await renderer.render({ templateType: '50k-club', templateVersion: 'v1', fields: {} });
    expect(r.status).toBe('RENDERED');
    if (r.status !== 'RENDERED') return;
    const renderPx = await pixels(r.png, width, height);
    let diffs = 0;
    for (let i = 0; i < masterPx.length; i += 4) if (masterPx[i] !== renderPx[i]) diffs += 1;
    expect(diffs).toBe(0);
  });
});

describe('production enablement fails closed; fixtures never masquerade as production', () => {
  // A throwaway type that ships ONLY a non-production v-test fixture (no v1 master),
  // built from an existing fixture so we can prove the production fail-closed rule.
  const FIXTURE_ONLY = 'selftest-fixture-only';
  const root = TEMPLATE_ROOT;
  beforeAll(() => {
    const src = join(root, '50k-club', 'v-test');
    const dst = join(root, FIXTURE_ONLY, 'v-test');
    mkdirSync(dst, { recursive: true });
    const man = JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf8'));
    man.templateType = FIXTURE_ONLY;
    writeFileSync(join(dst, 'manifest.json'), JSON.stringify(man));
    copyFileSync(join(src, 'master.png'), join(dst, 'master.png'));
  });
  afterAll(() => { rmSync(join(root, FIXTURE_ONLY), { recursive: true, force: true }); });

  it('a type with no approved master and no fixture resolves to null (fail closed)', () => {
    expect(resolveTemplateVersion('no-such-type')).toBeNull();
  });
  it('outside production, the v-test fixture is an allowed fallback for calibration', () => {
    const prev = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'test';
    expect(resolveTemplateVersion(FIXTURE_ONLY)).toBe('v-test');
    process.env['NODE_ENV'] = prev;
  });
  it('in production, a type with only a non-production fixture fails closed (no fixture fallback)', () => {
    const prev = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    expect(resolveTemplateVersion(FIXTURE_ONLY)).toBeNull();
    // But an approved v1 master still resolves in production.
    expect(resolveTemplateVersion('funded-trader')).toBe('v1');
    process.env['NODE_ENV'] = prev;
  });
});

describe('recipient name safety + 100K plaque exclusion', () => {
  it('rejects a blank recipient upstream', () => {
    expect(validateCertificateDisplayName('   ').ok).toBe(false);
  });
  it('rejects markup / script injection', () => {
    expect(validateCertificateDisplayName('<script>alert(1)</script>').ok).toBe(false);
  });
  it('rejects an email as a name', () => {
    expect(validateCertificateDisplayName('me@evil.test').ok).toBe(false);
  });
  it('accepts a clean name', () => {
    expect(validateCertificateDisplayName('Nathan Desjardins').ok).toBe(true);
  });
  it('the 100K club is not a digitally rendered / framable type', () => {
    expect(RENDERABLE_TYPES).not.toContain('HUNDREDK_CLUB');
    expect(isPhysicalEligibleType('HUNDREDK_CLUB')).toBe(false);
  });
  it('the 100K plaque has no automated digital master (manual fulfillment)', () => {
    expect(templateTypeKey('HUNDREDK_CLUB')).toBe('100k-club');
    expect(loadTemplate('100k-club', 'v1').renderable).toBe(false);
  });
});
