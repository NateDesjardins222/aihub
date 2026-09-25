/**
 * R | Protocol message router (Milestone 9).
 *
 * Decoded messages are dispatched to handlers keyed by message name, plus a
 * correlation path (user_msg) for request/response matching, plus an unknown
 * sink. Handlers never see protobuf internals — only decoded plain objects — so
 * plant logic stays free of wire concerns. A handler that throws is isolated:
 * one bad handler never stalls the router.
 */
import type { DecodedMessage } from './codec.js';

export type MessageHandler = (msg: DecodedMessage) => void;
export type UnknownHandler = (templateId: number, body: Uint8Array) => void;

export interface RouterStats {
  routed: number;
  unknown: number;
  handlerErrors: number;
}

export class MessageRouter {
  private readonly byName = new Map<string, Set<MessageHandler>>();
  private unknownHandler: UnknownHandler | null = null;
  private readonly stats: RouterStats = { routed: 0, unknown: 0, handlerErrors: 0 };
  /** correlationId -> one-shot resolver (for request/response via user_msg). */
  private readonly pending = new Map<string, (msg: DecodedMessage) => void>();

  on(name: string, handler: MessageHandler): () => void {
    let set = this.byName.get(name);
    if (!set) { set = new Set(); this.byName.set(name, set); }
    set.add(handler);
    return () => set!.delete(handler);
  }

  onUnknown(handler: UnknownHandler): void {
    this.unknownHandler = handler;
  }

  /** Register a one-shot correlation waiter keyed by the user_msg tag we sent. */
  awaitCorrelation(correlationId: string, resolve: (msg: DecodedMessage) => void): () => void {
    this.pending.set(correlationId, resolve);
    return () => this.pending.delete(correlationId);
  }

  route(msg: DecodedMessage): void {
    if (msg.name === null) {
      this.stats.unknown += 1;
      try { this.unknownHandler?.(msg.templateId, msg.body); } catch { this.stats.handlerErrors += 1; }
      return;
    }
    this.stats.routed += 1;
    // Correlation: a response echoing our user_msg resolves the matching waiter.
    const corr = correlationOf(msg.message);
    if (corr && this.pending.has(corr)) {
      const resolve = this.pending.get(corr)!;
      this.pending.delete(corr);
      try { resolve(msg); } catch { this.stats.handlerErrors += 1; }
    }
    const set = this.byName.get(msg.name);
    if (set) {
      for (const h of set) {
        try { h(msg); } catch { this.stats.handlerErrors += 1; }
      }
    }
  }

  getStats(): Readonly<RouterStats> {
    return { ...this.stats };
  }

  clear(): void {
    this.byName.clear();
    this.pending.clear();
    this.unknownHandler = null;
  }
}

/** Rithmic echoes the request's `user_msg` on the response; use it to correlate. */
function correlationOf(message: Record<string, unknown> | null): string | null {
  if (!message) return null;
  const um = message['user_msg'];
  if (Array.isArray(um) && um.length > 0 && typeof um[0] === 'string') return um[0];
  if (typeof um === 'string' && um !== '') return um;
  return null;
}
