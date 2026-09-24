/**
 * Certificate template manifests + bundled font registration (Milestone 6).
 *
 * Each template version ships `master.png` + `manifest.json` under
 * certificate-templates/<type>/<version>/. The manifest declares the canvas and
 * the approved dynamic fields (position, typography, alignment, overflow). Field
 * coordinates are NEVER hard-coded in application code — the renderer reads a
 * validated manifest. See docs/certificate-template-manifest.md.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { GlobalFonts } from '@napi-rs/canvas';

// ---- bundled fonts (deterministic, open-licensed) --------------------------

/** The only font families a manifest may reference. */
export const REGISTERED_FONT_FAMILIES = ['HappyTraderSans', 'HappyTraderSerif'] as const;
export type RegisteredFontFamily = (typeof REGISTERED_FONT_FAMILIES)[number];

/** Walk up from this module to the repo root that holds certificate-templates/. */
function findTemplateRoot(): string {
  if (process.env['CERTIFICATE_TEMPLATE_DIR']) return process.env['CERTIFICATE_TEMPLATE_DIR']!;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, 'certificate-templates');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  // Fall back to a repo-root guess; loadTemplate handles a missing dir safely.
  return join(process.cwd(), '..', '..', 'certificate-templates');
}

export const TEMPLATE_ROOT = findTemplateRoot();

let fontsRegistered = false;
/** Register the bundled fonts once. Idempotent. */
export function ensureFontsRegistered(): void {
  if (fontsRegistered) return;
  const fontsDir = join(TEMPLATE_ROOT, '_fonts');
  const reg = (file: string, family: string): void => {
    const p = join(fontsDir, file);
    if (existsSync(p)) GlobalFonts.registerFromPath(p, family);
  };
  reg('HappyTraderSans-Regular.ttf', 'HappyTraderSans');
  reg('HappyTraderSans-Bold.ttf', 'HappyTraderSans');
  reg('HappyTraderSerif-Regular.ttf', 'HappyTraderSerif');
  fontsRegistered = true;
}

// ---- manifest schema -------------------------------------------------------

const fieldSchema = z
  .object({
    x: z.number().finite().nonnegative(),
    y: z.number().finite().nonnegative(),
    width: z.number().finite().positive(),
    fontFamily: z.enum(REGISTERED_FONT_FAMILIES),
    fontSize: z.number().finite().positive().max(2000),
    fontWeight: z.number().int().min(100).max(900).default(400),
    letterSpacing: z.number().finite().default(0),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#111113'),
    alignment: z.enum(['left', 'center', 'right']).default('center'),
    maxLines: z.number().int().min(1).max(6).default(1),
    overflow: z.enum(['shrink', 'clip', 'ellipsis']).default('shrink'),
  })
  .strict();

export const manifestSchema = z
  .object({
    templateType: z.string().min(1),
    version: z.string().min(1),
    renderable: z.boolean().default(true),
    canvas: z
      .object({
        width: z.number().int().positive().max(20000),
        height: z.number().int().positive().max(20000),
      })
      .strict(),
    fields: z.record(z.string(), fieldSchema),
  })
  .strict();

export type CertificateManifest = z.infer<typeof manifestSchema>;
export type ManifestField = z.infer<typeof fieldSchema>;

export type ManifestValidation =
  | { ok: true; manifest: CertificateManifest }
  | { ok: false; reason: string };

/**
 * Validate a manifest against the expected type/version and its own canvas.
 * Deterministic, specific errors: bad shape, type/version mismatch, impossible
 * canvas, a field outside the canvas, an unsupported font. Every declared field's
 * box must fit inside the canvas.
 */
export function validateManifest(raw: unknown, expectedType: string, expectedVersion: string): ManifestValidation {
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: `Malformed manifest: ${parsed.error.issues[0]?.message ?? 'invalid'}` };
  }
  const m = parsed.data;
  if (m.templateType !== expectedType) return { ok: false, reason: `Manifest templateType ${m.templateType} != ${expectedType}.` };
  if (m.version !== expectedVersion) return { ok: false, reason: `Manifest version ${m.version} != ${expectedVersion}.` };
  if (Object.keys(m.fields).length === 0) return { ok: false, reason: 'Manifest declares no fields.' };
  for (const [name, f] of Object.entries(m.fields)) {
    if (f.x > m.canvas.width || f.y > m.canvas.height) {
      return { ok: false, reason: `Field ${name} anchor is outside the canvas.` };
    }
    if (f.width > m.canvas.width) {
      return { ok: false, reason: `Field ${name} width exceeds the canvas.` };
    }
  }
  return { ok: true, manifest: m };
}

export type LoadedTemplate =
  | { renderable: true; manifest: CertificateManifest; master: Buffer }
  | { renderable: false; reason: string };

/**
 * Load a template version's validated manifest + master image. Fails SAFE: a
 * missing directory, missing master, missing/invalid manifest, or an explicit
 * `renderable: false` returns { renderable: false } (the reward is still issued;
 * the artifact render is disabled), never a throw.
 */
export function loadTemplate(templateType: string, version: string): LoadedTemplate {
  const dir = join(TEMPLATE_ROOT, templateType, version);
  if (!existsSync(dir)) return { renderable: false, reason: `No template directory for ${templateType}/${version}.` };
  const manifestPath = join(dir, 'manifest.json');
  const masterPath = join(dir, 'master.png');
  if (!existsSync(manifestPath)) return { renderable: false, reason: 'Missing manifest.json.' };
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return { renderable: false, reason: 'Manifest is not valid JSON.' };
  }
  const validated = validateManifest(rawManifest, templateType, version);
  if (!validated.ok) return { renderable: false, reason: validated.reason };
  if (!validated.manifest.renderable) return { renderable: false, reason: 'Manifest marks this template non-renderable.' };
  if (!existsSync(masterPath)) return { renderable: false, reason: 'Missing master.png (approved artwork not installed).' };
  const master = readFileSync(masterPath);
  return { renderable: true, manifest: validated.manifest, master };
}

/** True when a renderable master exists for this type/version. */
export function templateAvailable(templateType: string, version: string): boolean {
  return loadTemplate(templateType, version).renderable;
}

/** List the versions present for a template type (for diagnostics). */
export function templateVersions(templateType: string): string[] {
  const dir = join(TEMPLATE_ROOT, templateType);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
}
