/** Sliding window of timestamps, keyed by API-key hash, not the raw key. */
export class SlidingWindowRateLimit {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(
    private readonly limit = 60,
    private readonly windowMs = 60_000,
  ) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("rate limit must be a positive integer");
    if (!Number.isInteger(windowMs) || windowMs < 1) throw new Error("rate window must be a positive integer");
  }

  allow(keyId: string, now = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    this.sweep(now, cutoff);
    const recent = (this.hits.get(keyId) ?? []).filter((stamp) => stamp > cutoff);
    if (recent.length >= this.limit) {
      this.hits.set(keyId, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(keyId, recent);
    return true;
  }

  /** Number of keys currently tracked (for tests and monitoring). */
  get size(): number {
    return this.hits.size;
  }

  /**
   * Drops keys with no hits inside the window so attacker-chosen keys
   * (random emails, rotating client addresses) cannot grow memory forever.
   * Runs at most once per window, or once a second while the map is large.
   */
  private sweep(now: number, cutoff: number): void {
    const interval = this.hits.size < MAX_TRACKED_KEYS ? this.windowMs : 1_000;
    if (now - this.lastSweep < interval) return;
    this.lastSweep = now;
    for (const [key, stamps] of this.hits) {
      if (!stamps.some((stamp) => stamp > cutoff)) this.hits.delete(key);
    }
  }
}

const MAX_TRACKED_KEYS = 50_000;
