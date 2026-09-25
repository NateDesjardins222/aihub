/**
 * rithmic:generate (Milestone 9).
 *
 * Binds the OFFICIAL RProtocolAPI package's proto definitions into Atlas's
 * gitignored runtime registry. The owner drops the package's `.proto` files in
 * vendor/rithmic/proto/ (or RITHMIC_VENDOR_DIR); this loads them, derives the
 * template-id ↔ message map from the schema itself, and writes a generated
 * registry manifest. It never copies the proprietary Reference_Guide.pdf, samples
 * or the ZIP — only the derived, minimal manifest. If the official package is
 * absent it explains what to do and exits 0 (non-blocking): the deterministic
 * test doubles remain in force.
 *
 *   pnpm --filter @atlas/server rithmic:generate
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveProtoInputs, loadSchema } from '../src/rithmic/protocol/registry.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GENERATED_DIR = join(HERE, '..', 'src', 'marketdata', 'rithmic', 'protocol', 'generated');

function main(): void {
  const vendorDir = process.env['RITHMIC_VENDOR_DIR'] ?? null;
  const { files, source } = resolveProtoInputs(vendorDir);
  if (source !== 'OFFICIAL_PACKAGE') {
    console.log('rithmic:generate — official package NOT found.');
    console.log('  Drop the RProtocolAPI package .proto files in apps/server/vendor/rithmic/proto/');
    console.log('  (or set RITHMIC_VENDOR_DIR), then re-run. Deterministic tests use the');
    console.log('  committed test-double schema until then. See docs/rithmic/rithmic-local-setup.md.');
    process.exit(0);
  }
  const schema = loadSchema({ vendorDir, force: true });
  const registry: Record<string, number> = {};
  for (const [name, id] of schema.nameToId) registry[name] = id;
  mkdirSync(GENERATED_DIR, { recursive: true });
  const manifest = {
    generatedAt: new Date().toISOString(),
    source,
    protoFiles: files.map((f) => f.replace(process.cwd(), '.')),
    templateIdField: schema.templateIdFieldNo,
    messageCount: Object.keys(registry).length,
    registry,
  };
  writeFileSync(join(GENERATED_DIR, 'registry.json'), JSON.stringify(manifest, null, 2));
  console.log(`rithmic:generate — bound ${manifest.messageCount} messages from the official package.`);
  console.log(`  wrote ${join(GENERATED_DIR, 'registry.json')} (gitignored).`);
}

main();
