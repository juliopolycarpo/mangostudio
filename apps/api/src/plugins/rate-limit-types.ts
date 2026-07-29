/** A named limit bucket: requests are counted per (bucket, client id). */
export interface RateLimitBucket {
  /** Identifier used to namespace the per-client counter store. */
  name: string;
  /** Maximum number of requests allowed per window. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
}
