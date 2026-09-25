/**
 * R | Protocol codec (Milestone 9).
 *
 * Encodes an Atlas-side message name + payload into a framed R | Protocol wire
 * buffer, and decodes an inbound frame back into { templateId, name, message }.
 * The template id is always taken from / verified against the loaded schema
 * registry — never hardcoded. Decoding first reads the template_id field directly
 * (schema-independent varint scan) so an unknown template routes safely instead
 * of throwing, and a malformed body is reported as a structured error.
 */
import protobuf from 'protobufjs';
import { frame, deframeOne } from './framing.js';
import { loadSchema, type LoadedSchema } from './registry.js';

export class CodecError extends Error {
  constructor(
    readonly code: 'UNKNOWN_MESSAGE' | 'UNKNOWN_TEMPLATE' | 'NO_TEMPLATE_ID' | 'DECODE_FAILED' | 'ENCODE_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'CodecError';
  }
}

export interface DecodedMessage {
  readonly templateId: number;
  /** Short message name when known (e.g. "ResponseLogin"); null for an unknown template. */
  readonly name: string | null;
  /** Decoded plain object when the template is known; null otherwise. */
  readonly message: Record<string, unknown> | null;
  /** Always present: the raw body, for diagnostics / unknown-template capture. */
  readonly body: Uint8Array;
}

/** Scan a protobuf body for the template_id varint field without a schema. */
export function readTemplateId(body: Uint8Array, fieldNo: number): number | null {
  const r = protobuf.Reader.create(body);
  while (r.pos < r.len) {
    const tag = r.uint32();
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === fieldNo && wire === 0) return r.int32();
    r.skipType(wire);
  }
  return null;
}

export class RithmicCodec {
  private readonly schema: LoadedSchema;

  constructor(schema?: LoadedSchema) {
    this.schema = schema ?? loadSchema();
  }

  get source(): LoadedSchema['source'] {
    return this.schema.source;
  }

  templateIdFor(name: string): number {
    const id = this.schema.nameToId.get(name);
    if (id === undefined) throw new CodecError('UNKNOWN_MESSAGE', `no template id for message "${name}"`);
    return id;
  }

  nameFor(templateId: number): string | null {
    const full = this.schema.idToName.get(templateId);
    if (!full) return null;
    const parts = full.split('.');
    return parts[parts.length - 1] ?? full;
  }

  /** Encode a message to its serialized protobuf body (no frame prefix). */
  encodeBody(name: string, payload: Record<string, unknown>): Uint8Array {
    const type = this.schema.types.get(name);
    if (!type) throw new CodecError('UNKNOWN_MESSAGE', `no schema type for message "${name}"`);
    const id = this.templateIdFor(name);
    const withId = { ...payload, template_id: id };
    const err = type.verify(withId);
    if (err) throw new CodecError('ENCODE_FAILED', `verify failed for ${name}: ${err}`);
    try {
      return type.encode(type.create(withId)).finish();
    } catch (e) {
      throw new CodecError('ENCODE_FAILED', `encode failed for ${name}: ${(e as Error).message}`);
    }
  }

  /** Encode + frame a message for the wire. */
  encode(name: string, payload: Record<string, unknown>): Buffer {
    return frame(this.encodeBody(name, payload));
  }

  /** Decode a serialized protobuf body (no frame prefix). */
  decodeBody(body: Uint8Array): DecodedMessage {
    const templateId = readTemplateId(body, this.schema.templateIdFieldNo);
    if (templateId === null) throw new CodecError('NO_TEMPLATE_ID', 'frame carries no template_id field');
    const name = this.nameFor(templateId);
    if (!name) return { templateId, name: null, message: null, body };
    const type = this.schema.types.get(name);
    if (!type) return { templateId, name, message: null, body };
    try {
      const decoded = type.decode(body);
      const obj = type.toObject(decoded, { longs: Number, enums: Number, defaults: false }) as Record<string, unknown>;
      return { templateId, name, message: obj, body };
    } catch (e) {
      throw new CodecError('DECODE_FAILED', `decode failed for ${name} (template ${templateId}): ${(e as Error).message}`);
    }
  }

  /** Deframe + decode a complete wire frame. */
  decode(wireFrame: Buffer): DecodedMessage {
    return this.decodeBody(deframeOne(wireFrame));
  }
}

let sharedCodec: RithmicCodec | null = null;
export function rithmicCodec(): RithmicCodec {
  if (!sharedCodec) sharedCodec = new RithmicCodec();
  return sharedCodec;
}
export function resetCodec(): void {
  sharedCodec = null;
}
