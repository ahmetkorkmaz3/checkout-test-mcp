/**
 * Browser slots that runs and inspections share. The capacity is max_parallel_runs,
 * so the server never has more browsers open than the config allows.
 * A waiter from acquire() gets a freed slot before a later tryAcquire() call,
 * so a stream of runs cannot keep an inspection waiting for ever.
 */
export class BrowserSlots {
  private used = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly listeners = new Set<() => void>();

  constructor(readonly capacity: number) {}

  /** Takes a slot when one is free and nobody waits. Never waits. */
  tryAcquire(): boolean {
    if (this.used >= this.capacity || this.waiters.length > 0) return false;
    this.used++;
    return true;
  }

  /** Waits for a free slot. Call release() once when the work ends. */
  acquire(): Promise<void> {
    if (this.tryAcquire()) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      // The slot goes to the waiter directly. The count stays the same.
      next();
      return;
    }
    this.used = Math.max(0, this.used - 1);
    for (const fn of this.listeners) fn();
  }

  /** Calls fn each time a slot becomes free. RunManager uses it to start a queued run. */
  onFree(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get inUse(): number {
    return this.used;
  }
}
