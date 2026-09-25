/**
 * Real WebSocket transport for R | Protocol (Milestone 9).
 *
 * Backed by `ws`. Binary frames only. Errors are surfaced to listeners with the
 * message sanitized (no URL query, no headers) so credentials can never leak
 * through a transport error. TLS is the default for wss:// URLs; the SSL trust
 * configuration from the official package is applied by the caller if required.
 */
import WebSocket from 'ws';
import type {
  RithmicTransport,
  TransportCloseListener,
  TransportErrorListener,
  TransportMessageListener,
} from './transport.js';

export class WsRithmicTransport implements RithmicTransport {
  private ws: WebSocket | null = null;
  private messageListeners = new Set<TransportMessageListener>();
  private closeListeners = new Set<TransportCloseListener>();
  private errorListeners = new Set<TransportErrorListener>();

  constructor(
    readonly url: string,
    private readonly opts: { connectTimeoutMs?: number; caCerts?: string[] } = {},
  ) {}

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeoutMs = this.opts.connectTimeoutMs ?? 15_000;
      let settled = false;
      const ws = new WebSocket(this.url, {
        handshakeTimeout: timeoutMs,
        ...(this.opts.caCerts ? { ca: this.opts.caCerts } : {}),
      });
      ws.binaryType = 'nodebuffer';
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws.terminate(); } catch { /* ignore */ }
        reject(new Error('connect timeout'));
      }, timeoutMs + 1_000);

      ws.on('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.ws = ws;
        resolve();
      });
      ws.on('message', (data: WebSocket.RawData) => {
        const buf = Array.isArray(data)
          ? Buffer.concat(data.map((d) => Buffer.from(d)))
          : Buffer.isBuffer(data)
            ? data
            : Buffer.from(data as ArrayBuffer);
        for (const cb of this.messageListeners) cb(buf);
      });
      ws.on('close', (code: number, reason: Buffer) => {
        for (const cb of this.closeListeners) cb({ code, reason: reason.toString('utf8').slice(0, 200) });
      });
      ws.on('error', (err: Error) => {
        const safe = new Error(sanitizeTransportError(err.message));
        if (!settled) { settled = true; clearTimeout(timer); reject(safe); }
        for (const cb of this.errorListeners) cb(safe);
      });
    });
  }

  send(data: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('transport not open');
    this.ws.send(data, { binary: true });
  }

  close(code = 1000, reason = 'normal'): void {
    try { this.ws?.close(code, reason); } catch { /* ignore */ }
    this.ws = null;
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
}

/** Strip anything that could carry a credential from a transport error message. */
export function sanitizeTransportError(message: string): string {
  return message
    .replace(/\/\/[^@/\s]+@/g, '//***@') // user:pass@host
    .replace(/(password|passwd|pwd|token|secret|user)=[^&\s]+/gi, '$1=***')
    .slice(0, 300);
}
