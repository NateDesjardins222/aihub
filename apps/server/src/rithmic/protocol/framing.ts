/**
 * R | Protocol wire framing (Milestone 9).
 *
 * Rithmic's R | Protocol frames each serialized protobuf message with a 4-byte,
 * big-endian, unsigned length prefix, then sends it as a single binary WebSocket
 * frame. This module is the ONLY place that knows the frame shape, so if the
 * official RProtocolAPI package documents a different prefix width it is a
 * one-line change here and nothing above the codec moves.
 *
 * The framing is validated against the official package's samples at
 * `rithmic:generate` / `rithmic:verify` time; the deterministic tests prove the
 * encode → decode round-trip is internally consistent and that malformed frames
 * are rejected safely (never a throw that leaks a partial buffer or a secret).
 */

/** Width of the big-endian unsigned length prefix, in bytes. */
export const LENGTH_PREFIX_BYTES = 4;

/** The largest single frame we will accept, a guard against a hostile/garbled length. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export class FramingError extends Error {
  constructor(
    readonly code: 'FRAME_TOO_LARGE' | 'TRUNCATED' | 'NEGATIVE_LENGTH',
    message: string,
  ) {
    super(message);
    this.name = 'FramingError';
  }
}

/** Prefix a serialized protobuf body with its big-endian length. */
export function frame(body: Uint8Array): Buffer {
  if (body.length > MAX_FRAME_BYTES) {
    throw new FramingError('FRAME_TOO_LARGE', `frame body ${body.length} exceeds ${MAX_FRAME_BYTES}`);
  }
  const out = Buffer.allocUnsafe(LENGTH_PREFIX_BYTES + body.length);
  out.writeUInt32BE(body.length, 0);
  Buffer.from(body).copy(out, LENGTH_PREFIX_BYTES);
  return out;
}

/** Decode exactly one frame from a complete buffer (the WS frame IS the message). */
export function deframeOne(buf: Buffer): Uint8Array {
  if (buf.length < LENGTH_PREFIX_BYTES) {
    throw new FramingError('TRUNCATED', `frame ${buf.length}B shorter than the ${LENGTH_PREFIX_BYTES}B prefix`);
  }
  const len = buf.readUInt32BE(0);
  if (len > MAX_FRAME_BYTES) throw new FramingError('FRAME_TOO_LARGE', `declared length ${len} exceeds ${MAX_FRAME_BYTES}`);
  const end = LENGTH_PREFIX_BYTES + len;
  if (buf.length < end) throw new FramingError('TRUNCATED', `frame declares ${len}B body but only ${buf.length - LENGTH_PREFIX_BYTES}B present`);
  return buf.subarray(LENGTH_PREFIX_BYTES, end);
}

/**
 * A streaming deframer for a byte stream that may deliver partial or coalesced
 * frames (a raw TCP/TLS socket rather than discrete WS messages). Buffers bytes
 * and yields each complete frame body. Kept separate so the transport can choose
 * message-mode (deframeOne) or stream-mode as the real socket requires.
 */
export class FrameStream {
  private buffered: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Uint8Array[] {
    this.buffered = this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk]);
    const out: Uint8Array[] = [];
    for (;;) {
      if (this.buffered.length < LENGTH_PREFIX_BYTES) break;
      const len = this.buffered.readUInt32BE(0);
      if (len > MAX_FRAME_BYTES) throw new FramingError('FRAME_TOO_LARGE', `declared length ${len} exceeds ${MAX_FRAME_BYTES}`);
      const end = LENGTH_PREFIX_BYTES + len;
      if (this.buffered.length < end) break; // wait for more bytes
      out.push(this.buffered.subarray(LENGTH_PREFIX_BYTES, end));
      this.buffered = this.buffered.subarray(end);
    }
    return out;
  }

  /** Bytes held awaiting a complete frame — a liveness/backpressure signal. */
  pending(): number {
    return this.buffered.length;
  }

  reset(): void {
    this.buffered = Buffer.alloc(0);
  }
}
