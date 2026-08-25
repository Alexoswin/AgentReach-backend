import { GROWW_RATE_LIMITS, GrowwRateBucket } from '../../config/groww';

/**
 * Shared token bucket for the Groww API.
 *
 * This is required, not an optimisation: a fan-out of five workers each polling
 * quotes will breach the published per-second limits on the very first cycle.
 * One instance is shared process-wide via `GrowwClientService`.
 *
 * Enforces both the per-second and per-minute ceiling per bucket by keeping a
 * timestamp ring and waiting for the oldest relevant entry to age out.
 */
export class GrowwRateLimiter {
  private readonly hits = new Map<GrowwRateBucket, number[]>();
  private readonly chains = new Map<GrowwRateBucket, Promise<void>>();

  /**
   * Serialises acquisition per bucket so two concurrent callers cannot both
   * observe "one slot free" and take it.
   */
  async acquire(bucket: GrowwRateBucket): Promise<void> {
    const previous = this.chains.get(bucket) ?? Promise.resolve();
    const next = previous.then(() => this.waitForSlot(bucket));

    // Keep the chain alive even if a waiter is cancelled upstream.
    this.chains.set(
      bucket,
      next.catch(() => undefined),
    );

    return next;
  }

  private async waitForSlot(bucket: GrowwRateBucket): Promise<void> {
    const limits = GROWW_RATE_LIMITS[bucket];

    for (;;) {
      const now = Date.now();
      const timestamps = this.prune(bucket, now);

      const inLastSecond = countSince(timestamps, now - 1000);
      const inLastMinute = timestamps.length;

      if (inLastSecond < limits.perSecond && inLastMinute < limits.perMinute) {
        timestamps.push(now);
        return;
      }

      const waitMs =
        inLastSecond >= limits.perSecond
          ? 1000 - (now - timestamps[timestamps.length - limits.perSecond])
          : 60_000 - (now - timestamps[0]);

      await sleep(Math.max(waitMs, 10));
    }
  }

  private prune(bucket: GrowwRateBucket, now: number) {
    const cutoff = now - 60_000;
    const timestamps = (this.hits.get(bucket) ?? []).filter((t) => t > cutoff);
    this.hits.set(bucket, timestamps);
    return timestamps;
  }

  /** Exposed for the policy screen so operators can see headroom. */
  snapshot() {
    const now = Date.now();
    return Object.fromEntries(
      (Object.keys(GROWW_RATE_LIMITS) as GrowwRateBucket[]).map((bucket) => {
        const timestamps = this.prune(bucket, now);
        return [
          bucket,
          {
            lastSecond: countSince(timestamps, now - 1000),
            lastMinute: timestamps.length,
            limits: GROWW_RATE_LIMITS[bucket],
          },
        ];
      }),
    );
  }
}

function countSince(sorted: number[], cutoff: number) {
  let count = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i] <= cutoff) break;
    count++;
  }
  return count;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
