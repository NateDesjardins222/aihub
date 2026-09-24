/**
 * Object / artifact storage abstraction (Milestone 6).
 *
 * Certificate artifacts (PNG, print PNG, PDF) are written here and referenced by
 * opaque storage KEYS on domain records — never disk paths. A local filesystem
 * adapter serves development and tests; a provider-ready S3 seam is selected by
 * env but disabled unless configured. Artifacts are write-once per key (never
 * silently overwritten); keys carry a random component so they are unguessable
 * and collision-free. Retrieval is always through an authenticated route.
 */
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';

export interface StoredObject {
  readonly key: string;
  readonly contentType: string;
  readonly size: number;
}

export interface ObjectStore {
  readonly name: 'LOCAL' | 'S3';
  /** Write once. Throws if the key already exists. */
  put(key: string, data: Buffer, contentType: string): Promise<StoredObject>;
  get(key: string): Promise<{ data: Buffer; contentType: string } | null>;
  exists(key: string): Promise<boolean>;
}

export class ObjectStoreError extends Error {
  constructor(readonly code: 'KEY_EXISTS' | 'INVALID_KEY' | 'NOT_CONFIGURED', message: string) {
    super(message);
    this.name = 'ObjectStoreError';
  }
}

/**
 * A safe artifact key: a stable prefix plus a random segment plus a bounded
 * basename. Only `[A-Za-z0-9/_.-]`, no leading slash, no `..` — so the local
 * adapter can never be walked out of its base directory.
 */
export function newArtifactKey(prefix: string, basename: string): string {
  const safeBase = basename.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  const safePrefix = prefix.replace(/[^A-Za-z0-9/_-]/g, '_').replace(/^\/+/, '');
  return `${safePrefix}/${randomUUID()}/${safeBase}`;
}

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9/_.-]{0,255}$/;
function assertSafeKey(key: string): void {
  if (!KEY_RE.test(key) || key.includes('..') || key.includes(`${sep}${sep}`)) {
    throw new ObjectStoreError('INVALID_KEY', 'Invalid storage key.');
  }
}

const CONTENT_TYPES = new Set(['image/png', 'application/pdf', 'application/octet-stream']);

/** Filesystem-backed store. Keys map to files under a confined base directory. */
export class LocalObjectStore implements ObjectStore {
  readonly name = 'LOCAL' as const;
  private readonly base: string;

  constructor(baseDir: string) {
    this.base = resolve(baseDir);
  }

  private pathFor(key: string): string {
    assertSafeKey(key);
    const p = resolve(this.base, key);
    // Defence in depth: the resolved path must stay inside the base dir.
    if (p !== this.base && !p.startsWith(this.base + sep)) {
      throw new ObjectStoreError('INVALID_KEY', 'Storage key escapes the base directory.');
    }
    return p;
  }

  async put(key: string, data: Buffer, contentType: string): Promise<StoredObject> {
    const type = CONTENT_TYPES.has(contentType) ? contentType : 'application/octet-stream';
    const path = this.pathFor(key);
    if (existsSync(path)) throw new ObjectStoreError('KEY_EXISTS', 'Artifact already exists; artifacts are write-once.');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
    // Store the content type in a sidecar so get() can return it faithfully.
    await writeFile(`${path}.type`, type, 'utf8');
    return { key, contentType: type, size: data.length };
  }

  async get(key: string): Promise<{ data: Buffer; contentType: string } | null> {
    const path = this.pathFor(key);
    try {
      const data = await readFile(path);
      let contentType = 'application/octet-stream';
      try { contentType = (await readFile(`${path}.type`, 'utf8')).trim() || contentType; } catch { /* default */ }
      return { data, contentType };
    } catch {
      return null;
    }
  }

  async exists(key: string): Promise<boolean> {
    try { await access(this.pathFor(key)); return true; } catch { return false; }
  }
}

/**
 * Provider-ready S3 seam. Intentionally unimplemented and DISABLED: selecting it
 * without credentials throws, so a misconfiguration fails loudly rather than
 * silently dropping artifacts. Wire a real SDK here in a later controlled step.
 */
export class S3ObjectStoreSeam implements ObjectStore {
  readonly name = 'S3' as const;
  async put(): Promise<StoredObject> { throw new ObjectStoreError('NOT_CONFIGURED', 'The S3 object store is not configured in this build.'); }
  async get(): Promise<{ data: Buffer; contentType: string } | null> { throw new ObjectStoreError('NOT_CONFIGURED', 'The S3 object store is not configured in this build.'); }
  async exists(): Promise<boolean> { throw new ObjectStoreError('NOT_CONFIGURED', 'The S3 object store is not configured in this build.'); }
}

let cached: ObjectStore | null = null;

/** The process object store, selected by env. Cached. Overridable in tests. */
export function objectStore(): ObjectStore {
  if (cached) return cached;
  const e = env();
  cached = e.OBJECT_STORE_PROVIDER === 's3' ? new S3ObjectStoreSeam() : new LocalObjectStore(join(process.cwd(), e.ARTIFACT_STORE_DIR));
  return cached;
}

/** Test-only override. */
export function setObjectStoreForTest(store: ObjectStore | null): void {
  cached = store;
}
