/** Sliding window of timestamps, keyed by API-key hash, not the raw key. */
export class SlidingWindowRateLimit {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit = 60,
    private readonly windowMs = 60_000,
  ) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("rate limit must be a positive integer");
    if (!Number.isInteger(windowMs) || windowMs < 1) throw new Error("rate window must be a positive integer");
  }

  allow(keyId: string, now = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(keyId) ?? []).filter((stamp) => stamp > cutoff);
    if (recent.length >= this.limit) {
      this.hits.set(keyId, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(keyId, recent);
    return true;
  }
}
