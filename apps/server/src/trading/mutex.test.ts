import { describe, expect, it } from 'vitest';
import { KeyedMutex } from './mutex.js';

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('KeyedMutex', () => {
  it('serializes tasks sharing a key', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    let inFlight = 0;
    let maxConcurrent = 0;

    const work = (label: string) =>
      mutex.run('acct', async () => {
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        order.push(`${label}:start`);
        await tick(5);
        order.push(`${label}:end`);
        inFlight -= 1;
      });

    await Promise.all([work('a'), work('b'), work('c')]);

    expect(maxConcurrent).toBe(1);
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  });

  it('runs different keys concurrently', async () => {
    const mutex = new KeyedMutex();
    let inFlight = 0;
    let maxConcurrent = 0;

    const work = (key: string) =>
      mutex.run(key, async () => {
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await tick(5);
        inFlight -= 1;
      });

    await Promise.all([work('a'), work('b'), work('c')]);
    expect(maxConcurrent).toBe(3);
  });

  /** A rejected order must not wedge the account it was submitted to. */
  it('keeps the queue moving when a task throws', async () => {
    const mutex = new KeyedMutex();
    const done: string[] = [];

    const failing = mutex.run('acct', async () => {
      throw new Error('rejected');
    });
    const following = mutex.run('acct', async () => {
      done.push('ran');
      return 42;
    });

    await expect(failing).rejects.toThrow('rejected');
    await expect(following).resolves.toBe(42);
    expect(done).toEqual(['ran']);
  });

  it('releases keys so the map does not grow without bound', async () => {
    const mutex = new KeyedMutex();
    for (let i = 0; i < 50; i += 1) {
      await mutex.run(`k${i}`, async () => undefined);
    }
    await tick(5);
    expect(mutex.activeKeys).toBe(0);
  });

  it('reports queue depth while work is pending', async () => {
    const mutex = new KeyedMutex();
    const first = mutex.run('acct', async () => tick(20));
    const second = mutex.run('acct', async () => tick(1));
    expect(mutex.depthOf('acct')).toBe(2);
    await Promise.all([first, second]);
    await tick(5);
    expect(mutex.depthOf('acct')).toBe(0);
  });

  /**
   * The race the engine actually faces: two market events arriving together,
   * each reading a shared value and writing it back.
   */
  it('prevents lost updates under concurrent read-modify-write', async () => {
    const mutex = new KeyedMutex();
    let position = 0;

    const applyFill = () =>
      mutex.run('acct', async () => {
        const read = position;
        await tick(2); // the database round-trip
        position = read + 1;
      });

    await Promise.all(Array.from({ length: 25 }, applyFill));
    expect(position).toBe(25);
  });
});
