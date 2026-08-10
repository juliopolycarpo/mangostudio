/**
 * Remembering what a Cursor discovery already established.
 *
 * Codex answers discovery from `account/read`, `model/list` and
 * `permissionProfile/list` — three cheap calls on one connection. Cursor has no
 * account-level model list at all: the catalog exists only on a live session, so
 * a full answer costs a process launch, an ACP handshake **and** a
 * `session/new`. The hub already caches per (user, environment) for 30 seconds,
 * which means that without a second cache here every selector render past that
 * window pays for all three again.
 *
 * The cache is keyed on everything that can make an answer wrong:
 *
 * - the **executable path**, so a second install elsewhere on `PATH` is a
 *   different entry rather than a stale one;
 * - the **version**, which is read on every call because it is one cheap
 *   `--version` and it is the thing a `cursor-agent update` changes;
 * - the **account fingerprint**, so signing out or switching accounts drops the
 *   entry rather than serving another account's model catalog.
 *
 * Failures are cached too, briefly and separately. A binary that cannot complete
 * the handshake fails *slowly* — a launch plus a timeout — and retrying that on
 * every render turns one broken install into a stall every time the selector
 * opens. The failure window is deliberately shorter than the hub's own TTL, so
 * a user who fixes their install is never more than a refresh away.
 *
 * What is deliberately **not** cached: anything that would let a stale entry
 * make a target look *more* capable than it is. An entry only ever replaces a
 * live probe of the same executable at the same version for the same account.
 */

import type { ExternalAgentRuntimeDescriptor } from '@mangostudio/shared/external-agents';

/** Where a descriptor came from, for the diagnostics the Logs page renders. */
type CursorDiscoverySource = 'live' | 'cache';

export interface CursorDiscoveryFacts {
  readonly executablePath: string;
  readonly version: string;
  /** Non-reversible account digest, or `undefined` when signed out or unknown. */
  readonly accountFingerprint: string | undefined;
}

export interface CursorDiscoveryOutcome {
  readonly descriptor: ExternalAgentRuntimeDescriptor;
  /** How many handshake attempts this answer took. One means it worked first time. */
  readonly attempts: number;
  /** Set when the answer is a recorded failure rather than a working target. */
  readonly failureCode?: string;
}

interface CacheEntry extends CursorDiscoveryOutcome {
  readonly facts: CursorDiscoveryFacts;
  readonly probedAtMs: number;
  readonly expiresAtMs: number;
}

export interface CursorDiscoveryRecord extends CursorDiscoveryOutcome {
  readonly source: CursorDiscoverySource;
  readonly probedAtMs: number;
}

export interface CursorDiscoveryCacheOptions {
  readonly successTtlMs: number;
  readonly failureTtlMs: number;
  readonly now: () => number;
}

function sameFacts(left: CursorDiscoveryFacts, right: CursorDiscoveryFacts): boolean {
  return (
    left.executablePath === right.executablePath &&
    left.version === right.version &&
    left.accountFingerprint === right.accountFingerprint
  );
}

/**
 * One entry, because one adapter instance drives one machine's `cursor-agent`.
 *
 * A map keyed by executable path would let a `PATH` change accumulate entries
 * for installs nobody can reach any more; replacing the single entry keeps the
 * cache the size of the thing it describes.
 */
export class CursorDiscoveryCache {
  #entry?: CacheEntry;
  readonly #successTtlMs: number;
  readonly #failureTtlMs: number;
  readonly #now: () => number;

  constructor(options: CursorDiscoveryCacheOptions) {
    this.#successTtlMs = options.successTtlMs;
    this.#failureTtlMs = options.failureTtlMs;
    this.#now = options.now;
  }

  /**
   * The remembered answer for these facts, or `undefined`.
   *
   * `accountFingerprint` is part of the key rather than a field to compare
   * afterwards, which is what makes "the account changed" an eviction rather
   * than a wrong answer someone has to notice.
   */
  read(facts: CursorDiscoveryFacts): CursorDiscoveryRecord | undefined {
    const entry = this.#entry;
    if (!entry) return undefined;
    if (!sameFacts(entry.facts, facts) || entry.expiresAtMs <= this.#now()) {
      this.#entry = undefined;
      return undefined;
    }
    return {
      descriptor: entry.descriptor,
      attempts: entry.attempts,
      ...(entry.failureCode ? { failureCode: entry.failureCode } : {}),
      source: 'cache',
      probedAtMs: entry.probedAtMs,
    };
  }

  write(facts: CursorDiscoveryFacts, outcome: CursorDiscoveryOutcome): CursorDiscoveryRecord {
    const probedAtMs = this.#now();
    const ttl = outcome.failureCode ? this.#failureTtlMs : this.#successTtlMs;
    this.#entry = { ...outcome, facts, probedAtMs, expiresAtMs: probedAtMs + ttl };
    return { ...outcome, source: 'live', probedAtMs };
  }

  /** Drops the entry. Used when a session open proves the cached answer wrong. */
  invalidate(): void {
    this.#entry = undefined;
  }
}
