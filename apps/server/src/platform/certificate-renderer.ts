/**
 * Deterministic certificate renderer (Milestone 6).
 *
 * Composites ONLY the approved dynamic fields (from the validated manifest) onto
 * the approved master image. No AI, no browser, no external image API, no client
 * viewport, no wall clock. Same templateType + templateVersion + fields +
 * rendererVersion ⇒ functionally identical output + identical renderHash.
 *
 * Raster via @napi-rs/canvas (prebuilt, no system deps) with bundled OFL fonts;
 * PDF via pdfkit (pure JS) embedding the print-resolution PNG. The library sits
 * behind the CertificateRenderer interface; swapping it bumps rendererVersion,
 * which is frozen per certificate so history stays stable.
 */
import { createHash } from 'node:crypto';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import PDFDocument from 'pdfkit';
import { ensureFontsRegistered, loadTemplate, type ManifestField } from './certificate-manifest.js';

export interface RenderInput {
  templateType: string;
  templateVersion: string;
  /** Resolved, already-formatted dynamic field values keyed by manifest field. */
  fields: Record<string, string>;
}

export type RenderResult =
  | { status: 'RENDERED'; png: Buffer; pdf: Buffer; renderHash: string; width: number; height: number }
  | { status: 'DISABLED'; reason: string }
  | { status: 'FAILED'; reason: string };

export interface CertificateRenderer {
  readonly version: string;
  render(input: RenderInput): Promise<RenderResult>;
}

const RENDERER_VERSION = 'r1';

function drawField(
  ctx: import('@napi-rs/canvas').SKRSContext2D,
  text: string,
  f: ManifestField,
): void {
  if (!text) return;
  ctx.fillStyle = f.color;
  ctx.textAlign = f.alignment;
  ctx.textBaseline = 'middle';
  try { (ctx as unknown as { letterSpacing: string }).letterSpacing = `${f.letterSpacing}px`; } catch { /* optional */ }

  // Shrink-to-fit: reduce the font size deterministically until the text fits the
  // field width, down to a floor. Single-line fields only in V1 masters.
  let size = f.fontSize;
  const floor = Math.max(8, Math.floor(f.fontSize * 0.4));
  const setFont = (px: number): void => { ctx.font = `${f.fontWeight} ${px}px "${f.fontFamily}"`; };
  setFont(size);
  if (f.overflow === 'shrink') {
    while (size > floor && ctx.measureText(text).width > f.width) {
      size -= 2;
      setFont(size);
    }
  }
  let out = text;
  if (ctx.measureText(out).width > f.width && f.overflow !== 'shrink') {
    // clip / ellipsis: trim from the end deterministically.
    const ell = f.overflow === 'ellipsis' ? '…' : '';
    while (out.length > 1 && ctx.measureText(out + ell).width > f.width) out = out.slice(0, -1);
    out = out + ell;
  }
  ctx.fillText(out, f.x, f.y);
}

export class CanvasCertificateRenderer implements CertificateRenderer {
  readonly version = RENDERER_VERSION;

  async render(input: RenderInput): Promise<RenderResult> {
    const loaded = loadTemplate(input.templateType, input.templateVersion);
    if (!loaded.renderable) return { status: 'DISABLED', reason: loaded.reason };
    try {
      ensureFontsRegistered();
      const { manifest, master } = loaded;
      const { width, height } = manifest.canvas;
      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext('2d');
      const img = await loadImage(master);
      ctx.drawImage(img, 0, 0, width, height);
      // Insert only the manifest's declared fields, in a stable (sorted) order.
      for (const name of Object.keys(manifest.fields).sort()) {
        const value = input.fields[name];
        if (value == null) continue;
        drawField(ctx, value, manifest.fields[name]!);
      }
      const png = canvas.toBuffer('image/png');
      const pdf = await pngToPdf(png, width, height);
      const renderHash = createHash('sha256')
        .update(png)
        .update(`${input.templateType}:${input.templateVersion}:${this.version}`)
        .digest('hex');
      return { status: 'RENDERED', png, pdf, renderHash, width, height };
    } catch (err) {
      return { status: 'FAILED', reason: err instanceof Error ? err.message.slice(0, 300) : 'render failed' };
    }
  }
}

/** Wrap a PNG into a single-page, print-ready PDF sized to the artwork. */
function pngToPdf(png: Buffer, width: number, height: number): Promise<Buffer> {
  return new Promise((resolvePdf, reject) => {
    try {
      const doc = new PDFDocument({ size: [width, height], margin: 0 });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolvePdf(Buffer.concat(chunks)));
      doc.on('error', reject);
      doc.image(png, 0, 0, { width, height });
      doc.end();
    } catch (err) {
      reject(err instanceof Error ? err : new Error('pdf failed'));
    }
  });
}

let cached: CertificateRenderer | null = null;
/** The process certificate renderer. Cached; overridable in tests. */
export function certificateRenderer(): CertificateRenderer {
  if (!cached) cached = new CanvasCertificateRenderer();
  return cached;
}
export function setCertificateRendererForTest(r: CertificateRenderer | null): void {
  cached = r;
}
