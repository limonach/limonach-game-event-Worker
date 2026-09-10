// js/rate-limiter.ts
//
// Rate limiting على مستوى الـpacket داخل الـDurable Object نفسه.

interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

export interface RateLimitConfig {
  maxTokens: number;
  refillIntervalMs: number;
}

export class RateLimiter {
  private buckets = new Map<string, BucketState>();
  private configs: Record<string, RateLimitConfig>;

  constructor(configs: Record<string, RateLimitConfig>) {
    this.configs = configs;
  }

  consume(packetType: string, nowMs: number = Date.now()): boolean {
    const config = this.configs[packetType];
    if (!config) return false;

    let bucket = this.buckets.get(packetType);
    if (!bucket) {
      bucket = { tokens: config.maxTokens, lastRefillMs: nowMs };
      this.buckets.set(packetType, bucket);
    }

    const elapsed = nowMs - bucket.lastRefillMs;
    const refillCount = Math.floor(elapsed / config.refillIntervalMs);
    if (refillCount > 0) {
      bucket.tokens = Math.min(config.maxTokens, bucket.tokens + refillCount);
      bucket.lastRefillMs = nowMs;
    }

    if (bucket.tokens <= 0) return false;
    bucket.tokens -= 1;
    return true;
  }
}

export const PHASE0_RATE_LIMITS: Record<string, RateLimitConfig> = {
  PING: { maxTokens: 5, refillIntervalMs: 500 },
  HELLO: { maxTokens: 1, refillIntervalMs: 60_000 },
};
