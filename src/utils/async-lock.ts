/**
 * Simple per-key async mutex for protecting read-modify-write operations.
 * Keys are automatically cleaned up when no one is waiting.
 */
export class AsyncKeyLock {
  private locks = new Map<string, Promise<void>>();

  async acquire(key: string): Promise<() => void> {
    // Wait for any existing lock on this key
    while (this.locks.has(key)) {
      await this.locks.get(key);
    }

    // Create a new lock
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    this.locks.set(key, promise);

    return () => {
      this.locks.delete(key);
      release();
    };
  }
}
