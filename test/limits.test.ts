import { describe, expect, it } from 'vitest';

import { IpLimiter, Semaphore, TokenBucket, hashKey } from '../src/limits';

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Semaphore', () => {
  it('hands out at most maxConcurrent slots', async () => {
    const semaphore = new Semaphore(2, 8);
    const a = await semaphore.acquire(50);
    const b = await semaphore.acquire(50);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(semaphore.depth).toBe(2);

    let third: unknown = 'pending';
    void semaphore.acquire(50).then((release) => {
      third = release;
    });

    await tick(10);
    expect(third).toBe('pending');

    a!();
    await tick(5);
    expect(third).not.toBe('pending');
    b!();
    (third as () => void)();
  });

  it('refuses when the queue is full and hands a slot to the queued request', async () => {
    const semaphore = new Semaphore(1, 1);
    const held = await semaphore.acquire(50);
    const queued = semaphore.acquire(50);
    expect(await semaphore.acquire(50)).toBeNull();
    held!();
    expect(await queued).not.toBeNull();
  });

  it('times out a waiter', async () => {
    const semaphore = new Semaphore(1, 4);
    const held = await semaphore.acquire(50);
    const started = Date.now();
    const waiter = await semaphore.acquire(20);
    expect(waiter).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
    held!();
  });

  it('release is idempotent', async () => {
    const semaphore = new Semaphore(1, 1);
    const release = await semaphore.acquire(50);
    release!();
    release!();
    expect(semaphore.depth).toBe(0);
  });
});

describe('TokenBucket', () => {
  it('allows a burst then refills', () => {
    const bucket = new TokenBucket(3, 1, 0);
    expect(bucket.take(0)).toBe(true);
    expect(bucket.take(0)).toBe(true);
    expect(bucket.take(0)).toBe(true);
    expect(bucket.take(0)).toBe(false);
    expect(bucket.take(1000)).toBe(true);
  });

  it('reports a retry delay', () => {
    const bucket = new TokenBucket(1, 0.5, 0);
    bucket.take(0);
    expect(bucket.retryAfterSeconds()).toBe(2);
  });
});

describe('IpLimiter', () => {
  it('separates keys and stays bounded', () => {
    const limiter = new IpLimiter(2, 1, 4);
    expect(limiter.take('a', 0)).toBe(true);
    expect(limiter.take('a', 0)).toBe(true);
    expect(limiter.take('a', 0)).toBe(false);
    expect(limiter.take('b', 0)).toBe(true);
    limiter.take('c', 0);
    limiter.take('d', 0);
    limiter.take('e', 0);
    expect(limiter.size).toBeLessThanOrEqual(4);
  });
});

describe('hashKey', () => {
  it('is stable and does not return the input', () => {
    const hashed = hashKey('203.0.113.9');
    expect(hashed).toBe(hashKey('203.0.113.9'));
    expect(hashed).not.toContain('203');
    expect(hashKey('203.0.113.9')).not.toBe(hashKey('203.0.113.10'));
  });
});
