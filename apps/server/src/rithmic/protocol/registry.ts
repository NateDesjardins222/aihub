/**
 * R | Protocol schema + template-id registry (Milestone 9).
 *
 * The protobuf schema is the authority for message shapes AND for the template-id
 * that identifies each message on the wire. This module loads that schema once —
 * from the OFFICIAL package when present, otherwise from the committed Atlas
 * test-double — and derives the id<->name map from it. Atlas code NEVER hardcodes
 * a template id: every id comes from the loaded schema, so dropping the official
 * RProtocolAPI package in vendor/rithmic/proto/ and running `rithmic:generate`
 * makes the official ids authoritative with no code change.
 *
 * The template_id field number (154467) is the documented R | Protocol convention
 * and lives in the schema; here we find the field by NAME ("template_id"), read
 * its number and default from the reflected schema, and build the map.
 */
import { readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import protobuf from 'protobufjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The committed test-double schema — used only when the official package is absent. */
export const TEST_DOUBLE_PROTO = join(HERE, '__fixtures__', 'atlas-rithmic-min.proto');

/** The documented R | Protocol template-id field name (its number lives in the schema). */
export const TEMPLATE_ID_FIELD = 'template_id';

export type SchemaSource = 'OFFICIAL_PACKAGE' | 'TEST_DOUBLE';

export interface LoadedSchema {
  readonly root: protobuf.Root;
  readonly source: SchemaSource;
  /** template_id -> fully-resolved message name (e.g. "rti.RequestLogin" or "RequestLogin"). */
  readonly idToName: ReadonlyMap<number, string>;
  /** message short name -> template_id. */
  readonly nameToId: ReadonlyMap<string, number>;
  /** message short name -> protobuf.Type. */
  readonly types: ReadonlyMap<string, protobuf.Type>;
  /** The protobuf field number of the template_id field (from the schema). */
  readonly templateIdFieldNo: number;
}

function listProtoFiles(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.proto'))
    .map((f) => join(dir, f))
    .sort();
}

/**
 * Resolve which proto files to load. Prefers the official package's proto dir
 * (RITHMIC_VENDOR_DIR/proto or apps/server/vendor/rithmic/proto), else the
 * committed test-double. Returns the source so callers can be honest about it.
 */
export function resolveProtoInputs(vendorDir?: string | null): { files: string[]; source: SchemaSource } {
  const candidates: string[] = [];
  if (vendorDir && vendorDir.trim() !== '') {
    candidates.push(join(vendorDir, 'proto'), vendorDir);
  }
  // Default local vendor location (gitignored).
  candidates.push(join(HERE, '..', '..', '..', 'vendor', 'rithmic', 'proto'));
  for (const dir of candidates) {
    const files = listProtoFiles(dir);
    if (files.length > 0) return { files, source: 'OFFICIAL_PACKAGE' };
  }
  return { files: [TEST_DOUBLE_PROTO], source: 'TEST_DOUBLE' };
}

function walkTypes(ns: protobuf.NamespaceBase, out: protobuf.Type[]): void {
  for (const nested of ns.nestedArray) {
    if (nested instanceof protobuf.Type) {
      out.push(nested);
      walkTypes(nested, out);
    } else if (nested instanceof protobuf.Namespace) {
      walkTypes(nested, out);
    }
  }
}

/** Build the id<->name maps from a loaded Root by reading each message's template_id field. */
export function buildRegistry(root: protobuf.Root, source: SchemaSource): LoadedSchema {
  const idToName = new Map<number, string>();
  const nameToId = new Map<string, number>();
  const types = new Map<string, protobuf.Type>();
  const all: protobuf.Type[] = [];
  walkTypes(root, all);
  let templateIdFieldNo = 0;
  for (const type of all) {
    const field = type.fields[TEMPLATE_ID_FIELD];
    if (!field) continue; // not a wire message (enums/nested value types)
    if (field.defaultValue === undefined || field.defaultValue === null) continue;
    const id = Number(field.defaultValue);
    if (!Number.isFinite(id)) continue;
    templateIdFieldNo = field.id;
    // Prefer the short name; keep the first definition if two collide.
    if (!nameToId.has(type.name)) {
      nameToId.set(type.name, id);
      types.set(type.name, type);
    }
    if (!idToName.has(id)) idToName.set(id, type.fullName.replace(/^\./, ''));
  }
  return { root, source, idToName, nameToId, types, templateIdFieldNo: templateIdFieldNo || 154467 };
}

let cached: LoadedSchema | null = null;

/** Load (and cache) the schema + registry. Pass a vendor dir to prefer the official package. */
export function loadSchema(opts: { vendorDir?: string | null; force?: boolean } = {}): LoadedSchema {
  if (cached && !opts.force) return cached;
  const { files, source } = resolveProtoInputs(opts.vendorDir);
  const root = new protobuf.Root();
  // Rithmic protos reference each other by bare filename; resolve within their dir.
  root.resolvePath = (origin, target) => {
    if (existsSync(target)) return target;
    for (const f of files) {
      const d = dirname(f);
      const candidate = join(d, target);
      if (existsSync(candidate)) return candidate;
    }
    return protobuf.util.path.resolve(origin, target);
  };
  root.loadSync(files, { keepCase: true });
  root.resolveAll();
  cached = buildRegistry(root, source);
  return cached;
}

export function resetSchemaCache(): void {
  cached = null;
}
