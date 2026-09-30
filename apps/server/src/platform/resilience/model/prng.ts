/**
 * Deterministic PRNG for state-machine fuzzing (Engineering Resilience Phase 3).
 *
 * A seeded generator so the same seed produces the same action sequence and the
 * same authoritative result. No dependency on Math.random. mulberry32 is a small,
 * fast, well-distributed 32-bit generator — enough to drive action selection.
 */
export class Prng {
  private state: number;
  constructor(readonly seed: number) {
    this.state = seed >>> 0;
  }
  /** Next float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    if (max < min) return min;
    return min + Math.floor(this.next() * (max - min + 1));
  }
  bool(pTrue = 0.5): boolean {
    return this.next() < pTrue;
  }
  /** Pick one element uniformly. */
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(0, arr.length - 1)]!;
  }
  /** Pick one element by weight (weights need not sum to 1). */
  weighted<T>(items: readonly (readonly [T, number])[]): T {
    const total = items.reduce((s, [, w]) => s + w, 0);
    let r = this.next() * total;
    for (const [item, w] of items) {
      r -= w;
      if (r < 0) return item;
    }
    return items[items.length - 1]![0];
  }
}

/** FNV-1a 32-bit hash of a string, hex — a stable, dependency-free digest. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
