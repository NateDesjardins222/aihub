/**
 * R | Protocol transport (Milestone 9).
 *
 * A message-oriented duplex channel: each inbound/outbound message is one
 * length-prefixed protobuf frame carried as a single binary WebSocket message.
 * The transport knows nothing about protobuf — it moves Buffers. Two
 * implementations: the real `ws`-backed one, and a deterministic in-memory mock
 * used by every test so the whole connection/plant/reconnect machinery runs with
 * no network and no real Rithmic.
 */
export type TransportMessageListener = (data: Buffer) => void;
export type TransportCloseListener = (info: { code: number; reason: string }) => void;
export type TransportErrorListener = (err: Error) => void;

export interface RithmicTransport {
  readonly url: string;
  isOpen(): boolean;
  connect(): Promise<void>;
  send(data: Buffer): void;
  close(code?: number, reason?: string): void;
  onMessage(cb: TransportMessageListener): () => void;
  onClose(cb: TransportCloseListener): () => void;
  onError(cb: TransportErrorListener): () => void;
}

export type TransportFactory = (url: string) => RithmicTransport;

/**
 * A deterministic in-memory transport. Tests drive the "server side" via
 * `serverHandler` (auto-respond to each frame the client sends) and/or
 * `injectMessage` / `injectClose` / `injectError`. It records everything sent.
 */
export class MockRithmicTransport implements RithmicTransport {
  private open = false;
  readonly sent: Buffer[] = [];
  private messageListeners = new Set<TransportMessageListener>();
  private closeListeners = new Set<TransportCloseListener>();
  private errorListeners = new Set<TransportErrorListener>();

  /** When set, each sent frame is passed here; return frames to inject as replies. */
  serverHandler: ((frame: Buffer) => Buffer[] | void) | null = null;
  /** Force connect() to reject, to exercise CONNECTING → FAILED. */
  failConnect = false;

  constructor(readonly url = 'wss://mock.rithmic.test:443') {}

  isOpen(): boolean {
    return this.open;
  }

  async connect(): Promise<void> {
    if (this.failConnect) throw new Error('mock connect refused');
    this.open = true;
  }

  send(data: Buffer): void {
    if (!this.open) throw new Error('transport not open');
    this.sent.push(data);
    const replies = this.serverHandler?.(data);
    if (replies) for (const r of replies) this.injectMessage(r);
  }

  close(code = 1000, reason = 'normal'): void {
    if (!this.open) return;
    this.open = false;
    for (const cb of this.closeListeners) cb({ code, reason });
  }

  onMessage(cb: TransportMessageListener): () => void {
    this.messageListeners.add(cb);
    return () => this.messageListeners.delete(cb);
  }
  onClose(cb: TransportCloseListener): () => void {
    this.closeListeners.add(cb);
    return () => this.closeListeners.delete(cb);
  }
  onError(cb: TransportErrorListener): () => void {
    this.errorListeners.add(cb);
    return () => this.errorListeners.delete(cb);
  }

  // -- test-side injection ----------------------------------------------------
  injectMessage(data: Buffer): void {
    for (const cb of this.messageListeners) cb(data);
  }
  injectClose(code = 1006, reason = 'abnormal'): void {
    this.open = false;
    for (const cb of this.closeListeners) cb({ code, reason });
  }
  injectError(err: Error): void {
    for (const cb of this.errorListeners) cb(err);
  }
  lastSent(): Buffer | undefined {
    return this.sent[this.sent.length - 1];
  }
}
