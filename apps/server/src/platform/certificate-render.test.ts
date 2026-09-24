/**
 * Certificate renderer + template manifest + object store (Milestone 6).
 *
 * Determinism (same inputs → identical hash), sensitivity (name/amount change the
 * artifact), fail-safe (missing master → DISABLED), manifest validation, PNG/PDF
 * generation, no markup execution, and object-store write-once + path-traversal
 * safety. Pure and DB-free.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanvasCertificateRenderer } from './certificate-renderer.js';
import { validateManifest, loadTemplate, templateAvailable } from './certificate-manifest.js';
import { LocalObjectStore, newArtifactKey, ObjectStoreError } from './object-store.js';

const renderer = new CanvasCertificateRenderer();
const baseFields = { recipientName: 'Nathan D.', value: '$1,700', date: 'March 2026' };

async function hashOf(fields: Record<string, string>): Promise<string> {
  const r = await renderer.render({ templateType: 'payout', templateVersion: 'v-test', fields });
  if (r.status !== 'RENDERED') throw new Error(`expected RENDERED, got ${r.status}`);
  return r.renderHash;
}

describe('certificate renderer — determinism & sensitivity', () => {
  it('renders a PNG and a PDF for a fixture template', async () => {
    const r = await renderer.render({ templateType: 'payout', templateVersion: 'v-test', fields: baseFields });
    expect(r.status).toBe('RENDERED');
    if (r.status !== 'RENDERED') return;
    expect(r.png.slice(0, 8).toString('hex')).toBe('89504e470d0a1a0a'); // PNG magic
    expect(r.pdf.slice(0, 5).toString()).toBe('%PDF-');
    expect(r.width).toBeGreaterThan(0);
    expect(r.renderHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic — same inputs produce the same renderHash', async () => {
    const a = await hashOf(baseFields);
    const b = await hashOf(baseFields);
    expect(a).toBe(b);
  });

  it('a different recipient name changes the artifact hash', async () => {
    const a = await hashOf(baseFields);
    const b = await hashOf({ ...baseFields, recipientName: 'Alex P.' });
    expect(a).not.toBe(b);
  });

  it('a different amount changes the artifact hash', async () => {
    const a = await hashOf(baseFields);
    const b = await hashOf({ ...baseFields, value: '$2,000' });
    expect(a).not.toBe(b);
  });

  it('the renderer version is frozen and stable', () => {
    expect(renderer.version).toBe('r1');
  });

  it('renders every fixture certificate family', async () => {
    for (const t of ['funded-trader', 'payout', 'account-completed', '10k-club', '50k-club']) {
      const r = await renderer.render({ templateType: t, templateVersion: 'v-test', fields: baseFields });
      expect(r.status, t).toBe('RENDERED');
    }
  });

  it('a missing master fails safe as DISABLED (never a throw or broken image)', async () => {
    const r = await renderer.render({ templateType: 'payout', templateVersion: 'v-does-not-exist', fields: baseFields });
    expect(r.status).toBe('DISABLED');
  });

  it('the 100K club has no render master (manual plaque)', () => {
    expect(templateAvailable('100k-club', 'v-test')).toBe(false);
  });

  it('does not execute markup in a field value — it is drawn as text', async () => {
    const r = await renderer.render({
      templateType: 'payout', templateVersion: 'v-test',
      fields: { ...baseFields, recipientName: '<script>alert(1)</script>' },
    });
    expect(r.status).toBe('RENDERED');
    if (r.status === 'RENDERED') expect(r.png.length).toBeGreaterThan(1000);
  });

  it('an overlong name is shrunk to fit deterministically', async () => {
    const long = 'A'.repeat(200);
    const a = await hashOf({ ...baseFields, recipientName: long });
    const b = await hashOf({ ...baseFields, recipientName: long });
    expect(a).toBe(b);
  });
});

describe('template manifest validation', () => {
  const good = {
    templateType: 'payout', version: 'v1', renderable: true,
    canvas: { width: 1000, height: 800 },
    fields: { recipientName: { x: 500, y: 400, width: 800, fontFamily: 'HappyTraderSans', fontSize: 40 } },
  };

  it('accepts a well-formed manifest', () => {
    expect(validateManifest(good, 'payout', 'v1').ok).toBe(true);
  });
  it('rejects a type mismatch', () => {
    expect(validateManifest(good, 'funded-trader', 'v1')).toMatchObject({ ok: false });
  });
  it('rejects a version mismatch', () => {
    expect(validateManifest(good, 'payout', 'v2')).toMatchObject({ ok: false });
  });
  it('rejects impossible canvas dimensions', () => {
    expect(validateManifest({ ...good, canvas: { width: 0, height: 800 } }, 'payout', 'v1')).toMatchObject({ ok: false });
  });
  it('rejects an unsupported font', () => {
    const bad = { ...good, fields: { recipientName: { ...good.fields.recipientName, fontFamily: 'Comic Sans' } } };
    expect(validateManifest(bad, 'payout', 'v1')).toMatchObject({ ok: false });
  });
  it('rejects a field anchored outside the canvas', () => {
    const bad = { ...good, fields: { recipientName: { ...good.fields.recipientName, x: 5000 } } };
    expect(validateManifest(bad, 'payout', 'v1')).toMatchObject({ ok: false });
  });
  it('rejects a field width exceeding the canvas', () => {
    const bad = { ...good, fields: { recipientName: { ...good.fields.recipientName, width: 5000 } } };
    expect(validateManifest(bad, 'payout', 'v1')).toMatchObject({ ok: false });
  });
  it('rejects a manifest with no fields', () => {
    expect(validateManifest({ ...good, fields: {} }, 'payout', 'v1')).toMatchObject({ ok: false });
  });
  it('rejects an unknown extra property (strict)', () => {
    expect(validateManifest({ ...good, bogus: true }, 'payout', 'v1')).toMatchObject({ ok: false });
  });
  it('the payout fixture manifest loads and is renderable', () => {
    const t = loadTemplate('payout', 'v-test');
    expect(t.renderable).toBe(true);
  });
});

describe('object store — write-once + path safety', () => {
  const dir = mkdtempSync(join(tmpdir(), 'objstore-'));
  const store = new LocalObjectStore(dir);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('put then get round-trips the bytes and content type', async () => {
    const key = newArtifactKey('certificates', 'x.png');
    await store.put(key, Buffer.from('hello'), 'image/png');
    const got = await store.get(key);
    expect(got?.data.toString()).toBe('hello');
    expect(got?.contentType).toBe('image/png');
  });

  it('is write-once — a second put on the same key is rejected', async () => {
    const key = newArtifactKey('certificates', 'y.png');
    await store.put(key, Buffer.from('a'), 'image/png');
    await expect(store.put(key, Buffer.from('b'), 'image/png')).rejects.toBeInstanceOf(ObjectStoreError);
  });

  it('exists reflects presence', async () => {
    const key = newArtifactKey('certificates', 'z.png');
    expect(await store.exists(key)).toBe(false);
    await store.put(key, Buffer.from('a'), 'image/png');
    expect(await store.exists(key)).toBe(true);
  });

  it('rejects a path-traversal key', async () => {
    await expect(store.get('../../etc/passwd')).rejects.toBeInstanceOf(ObjectStoreError);
    await expect(store.put('../escape', Buffer.from('x'), 'image/png')).rejects.toBeInstanceOf(ObjectStoreError);
  });

  it('get of an unknown key returns null', async () => {
    expect(await store.get(newArtifactKey('certificates', 'missing.png'))).toBeNull();
  });

  it('newArtifactKey is unguessable and namespaced', () => {
    const k1 = newArtifactKey('certificates', 'a.png');
    const k2 = newArtifactKey('certificates', 'a.png');
    expect(k1).not.toBe(k2);
    expect(k1.startsWith('certificates/')).toBe(true);
  });
});
