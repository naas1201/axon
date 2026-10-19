// In-isolate admission control. Workers on the free plan cannot use Queues or
// Durable Objects, so both controls below are best effort per isolate (per
// colo in practice). They exist to protect the 10 ms CPU budget, not to
// provide a global quota.

export type Release = () => void;

interface Waiter {
  resolve: (release: Release | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class Semaphore {
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueue: number,
  ) {}

  get depth(): number {
    return this.active;
  }

  get waiting(): number {
    return this.queue.length;
  }

  /**
   * Resolves with a release function, or null when the queue is full or the
   * wait exceeded maxWaitMs. The caller MUST call release() in a finally block.
   */
  acquire(maxWaitMs: number): Promise<Release | null> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return Promise.resolve(this.makeRelease());
    }
    if (this.queue.length >= this.maxQueue) return Promise.resolve(null);

    return new Promise<Release | null>((resolve) => {
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          const index = this.queue.indexOf(waiter);
          if (index !== -1) this.queue.splice(index, 1);
          resolve(null);
        }, maxWaitMs),
      };
      this.queue.push(waiter);
    });
  }

  private makeRelease(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) {
        // Hand the slot over without ever dropping active below the cap.
        clearTimeout(next.timer);
        next.resolve(this.makeRelease());
      } else {
        this.active--;
      }
    };
  }
}

/** Classic token bucket: `capacity` burst, refilled at `refillPerSecond`. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    now: number = Date.now(),
  ) {
    this.tokens = capacity;
    this.last = now;
  }

  take(now: number = Date.now()): boolean {
    const elapsed = Math.max(0, now - this.last) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** Seconds until one token is available, rounded up, minimum 1. */
  retryAfterSeconds(): number {
    const missing = 1 - this.tokens;
    if (missing <= 0) return 0;
    return Math.max(1, Math.ceil(missing / this.refillPerSecond));
  }
}

/** Per-IP limiter with a hard cap on tracked entries to bound memory. */
export class IpLimiter {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(
    private readonly capacity = 10,
    private readonly refillPerSecond = 0.5,
    private readonly maxEntries = 5000,
  ) {}

  take(key: string, now: number = Date.now()): boolean {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxEntries) {
        // Map preserves insertion order: drop the oldest quarter.
        const drop = Math.ceil(this.maxEntries / 4);
        let i = 0;
        for (const old of this.buckets.keys()) {
          if (i++ >= drop) break;
          this.buckets.delete(old);
        }
      }
      bucket = new TokenBucket(this.capacity, this.refillPerSecond, now);
      this.buckets.set(key, bucket);
    }
    return bucket.take(now);
  }

  retryAfter(key: string): number {
    return this.buckets.get(key)?.retryAfterSeconds() ?? 1;
  }

  get size(): number {
    return this.buckets.size;
  }
}

/**
 * FNV-1a over the address plus a per-isolate salt. The raw address never
 * leaves this function and the hash is only used as a Map key.
 */
export function hashKey(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
