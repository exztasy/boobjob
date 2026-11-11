/**
 * Runs tasks that share a key one after another, in the order they were queued.
 * Tasks with different keys run independently.
 */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, task: () => Promise<T> | T): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    // The chain must survive a failing task, and the caller is the one who handles the failure.
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  /** Number of keys with work queued or running. */
  get size(): number {
    return this.tails.size;
  }
}
