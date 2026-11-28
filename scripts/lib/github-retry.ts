// The one retry policy for GitHub API reads in scripts/ci and scripts/lib. Both
// transports (`fetch` and the `gh` CLI) classify failures here, so a 502, a
// rate limit or an unsettled listing is handled the same way everywhere.
//
// Node/Bun built-ins only: some callers run without `bun install`.

export type GithubFetch = (url: string, init: RequestInit) => Promise<Response>;

/** What a policy allows. Attempts are `backoffMs.length + 1`. */
export interface RetryPolicy {
  /** Waits before attempt 2, 3, ...; a server-requested wait can only lengthen one. */
  readonly backoffMs: readonly number[];
  /** Longest `Retry-After` / `x-ratelimit-reset` wait honored; a longer ask fails instead of sleeping. */
  readonly maxServerWaitMs: number;
  /** Hard bound on the total wait of one `GitHubRetry`; once spent, the next failure is final. */
  readonly maxTotalWaitMs: number;
}

/**
 * Worst-case wait of one `GitHubRetry` is `maxTotalWaitMs`, independent of page
 * count or nesting, because requests and listing passes spend the same budget.
 * A failed attempt itself costs up to its request timeout on top (30 s for the
 * fetch clients), so a caller's step timeout must cover
 * `maxTotalWaitMs + (attempts spent) * timeout`.
 *
 * Standard: three attempts, 5 s then 10 s, at most 60 s of waiting. Used by the
 * cache cleanups (steps of 10, 15 and 30 minutes), the native watch gate and
 * report (9-minute jobs that may spend four minutes in Bun setup) and the canary
 * recovery reads.
 */
export const STANDARD_RETRY_POLICY: RetryPolicy = {
  backoffMs: [5_000, 10_000],
  maxServerWaitMs: 30_000,
  maxTotalWaitMs: 60_000,
};

/**
 * Advisory report whose collector allows 3 s per request and 15 s overall: one
 * retry after 0.5 s, at most 1 s of waiting. Waits stop when the request's
 * signal aborts.
 */
export const ADVISORY_RETRY_POLICY: RetryPolicy = {
  backoffMs: [500],
  maxServerWaitMs: 1_000,
  maxTotalWaitMs: 1_000,
};

/**
 * Artifact download: one retry after 2 s, at most 2 s of waiting. Callers declare
 * a 3-minute step deadline and each attempt is bounded at 85 s, so 2 * 85 + 2 =
 * 172 s fits.
 */
export const ARTIFACT_DOWNLOAD_RETRY_POLICY: RetryPolicy = {
  backoffMs: [2_000],
  maxServerWaitMs: 2_000,
  maxTotalWaitMs: 2_000,
};

/** Injectable so tests wait for nothing. */
export interface RetryEnvironment {
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly now: () => number;
  /**
   * Blocking wait for `ghCommandSync`, whose callers are synchronous APIs. Absent
   * in an environment that only serves the asynchronous methods.
   */
  readonly sleepSync?: (milliseconds: number) => void;
}

const SYSTEM_RETRY_ENVIRONMENT: RetryEnvironment = {
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now: () => Date.now(),
  // Atomics.wait on a private cell that nothing notifies: a portable blocking sleep.
  sleepSync: (milliseconds) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  },
};

/** A listing whose entry count disagrees with its reported total: GitHub was mid-update. */
export class IncompleteListing extends Error {}

/** A listing whose total or membership moved between pages: something was saved or deleted mid-read. */
export class UnstableListing extends Error {}

/** A request that got no HTTP answer: DNS, reset, timeout or a body cut short. */
export class GitHubNetworkFailure extends Error {}

/** An HTTP error answer, with what classification needs from it. */
export class GitHubHttpFailure extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly header: (name: string) => string | undefined = () => undefined,
    readonly body = ''
  ) {
    super(message);
  }
}

/** Thrown when retries ended the read; outer layers never retry it, so waits do not multiply. */
export class GitHubRetriesExhausted extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    cause: unknown
  ) {
    super(message, { cause });
  }
}

type RetryDecision =
  | { readonly retry: false }
  | { readonly retry: true; readonly serverWaitMs?: number; readonly reason: string };

const NO_RETRY: RetryDecision = { retry: false };
const RATE_LIMIT_BODY = /secondary rate limit|abuse detection|rate limit/i;
const NETWORK_STDERR =
  /\b(?:timeout|timed out|EOF|connection reset|connection refused|temporar(?:y|ily)|unexpected end)\b/i;

function serverWaitMs(failure: GitHubHttpFailure, now: number): number | undefined {
  const retryAfter = failure.header('retry-after');
  if (retryAfter !== undefined) {
    if (/^\d+$/.test(retryAfter)) return Number(retryAfter) * 1000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  const reset = failure.header('x-ratelimit-reset');
  if (
    failure.header('x-ratelimit-remaining') === '0' &&
    reset !== undefined &&
    /^\d+$/.test(reset)
  ) {
    return Math.max(0, Number(reset) * 1000 - now);
  }
  return undefined;
}

/**
 * Classify one failed request. Network errors and 5xx may have reached the
 * server, so a write (`idempotent: false`) never retries them: a repeated POST
 * would duplicate. A rate limit (429, or 403 naming a limit) is rejected before
 * processing and is retried for any method.
 * @example judgeRequestFailure(new GitHubHttpFailure('x', 502), true, Date.now());
 */
function judgeRequestFailure(failure: unknown, idempotent: boolean, now: number): RetryDecision {
  if (failure instanceof GitHubNetworkFailure) {
    return idempotent ? { retry: true, reason: 'network error' } : NO_RETRY;
  }
  if (!(failure instanceof GitHubHttpFailure)) return NO_RETRY;
  const { status } = failure;
  const limited =
    status === 429 ||
    (status === 403 &&
      (failure.header('retry-after') !== undefined ||
        failure.header('x-ratelimit-remaining') === '0' ||
        RATE_LIMIT_BODY.test(failure.body)));
  if (limited) {
    return {
      retry: true,
      reason: `rate limited (HTTP ${status})`,
      serverWaitMs: serverWaitMs(failure, now),
    };
  }
  if (status >= 500 && idempotent) return { retry: true, reason: `HTTP ${status}` };
  return NO_RETRY;
}

/** Turn gh stderr into a classifiable failure, or undefined when it names nothing transient. */
export function failureFromGhStderr(
  stderr: string
): GitHubHttpFailure | GitHubNetworkFailure | undefined {
  const status = /\bHTTP (\d{3})\b/.exec(stderr)?.[1];
  if (status !== undefined) {
    return new GitHubHttpFailure(
      `gh failed with HTTP ${status}`,
      Number(status),
      undefined,
      stderr
    );
  }
  return NETWORK_STDERR.test(stderr) ? new GitHubNetworkFailure('gh transport failure') : undefined;
}

type Attempted<T> =
  { readonly value: T } | { readonly failure: unknown; readonly decision: RetryDecision };

interface Driven<T> {
  readonly attempted: Attempted<T>;
  readonly attempts: number;
  /** Why a retryable failure was not retried again; absent when it was not retryable or the caller aborted. */
  readonly stoppedBy?: string;
}

/**
 * One retry runtime: a policy, a clock and the wait budget they spend. Hold one
 * per client so its requests and listing passes share the budget.
 * @example const retry = new GitHubRetry(STANDARD_RETRY_POLICY);
 */
export class GitHubRetry {
  private remainingWaitMs: number;

  constructor(
    private readonly policy: RetryPolicy = STANDARD_RETRY_POLICY,
    private readonly environment: RetryEnvironment = SYSTEM_RETRY_ENVIRONMENT
  ) {
    this.remainingWaitMs = policy.maxTotalWaitMs;
  }

  /**
   * Milliseconds this runtime has spent waiting so far. A caller that read
   * state before a wait can compare the value before and after to learn that
   * the state may have moved while it slept.
   * @example const before = retry.waitedMs; await read(); if (retry.waitedMs !== before) restart();
   */
  get waitedMs(): number {
    return this.policy.maxTotalWaitMs - this.remainingWaitMs;
  }

  /**
   * The wait before attempt `number + 1`, charged to the budget, or why there is
   * none. Both the async and the blocking driver schedule through here so their
   * limits cannot drift.
   */
  private nextWait(
    number: number,
    decision: Extract<RetryDecision, { readonly retry: true }>
  ): { readonly waitMs: number } | { readonly stoppedBy: string } {
    const scheduled = this.policy.backoffMs[number - 1];
    if (scheduled === undefined) return { stoppedBy: 'attempt schedule spent' };
    const asked = decision.serverWaitMs ?? 0;
    if (asked > this.policy.maxServerWaitMs) {
      return {
        stoppedBy: `server asked for ${Math.ceil(asked / 1000)} s, over the ${this.policy.maxServerWaitMs / 1000} s cap`,
      };
    }
    const wait = Math.max(scheduled, asked);
    if (wait > this.remainingWaitMs) {
      return { stoppedBy: `${this.policy.maxTotalWaitMs / 1000} s wait budget spent` };
    }
    this.remainingWaitMs -= wait;
    return { waitMs: wait };
  }

  private async drive<T>(
    attempt: (number: number) => Promise<Attempted<T>>,
    signal?: AbortSignal
  ): Promise<Driven<T>> {
    for (let number = 1; ; number++) {
      const attempted = await attempt(number);
      if ('value' in attempted || !attempted.decision.retry) return { attempted, attempts: number };
      if (signal?.aborted) return { attempted, attempts: number };
      const next = this.nextWait(number, attempted.decision);
      if ('stoppedBy' in next) {
        return { attempted, attempts: number, stoppedBy: next.stoppedBy };
      }
      await this.environment.sleep(next.waitMs);
    }
  }

  /** The failure to throw: unchanged when nothing was retried, else one outer layers will not retry. */
  private final(label: string, driven: Driven<unknown>, failure: unknown): unknown {
    if (driven.stoppedBy === undefined) return failure;
    const reason = failure instanceof Error ? failure.message : String(failure);
    return new GitHubRetriesExhausted(
      `${reason}; ${label} gave up after ${driven.attempts} attempts (${driven.stoppedBy})`,
      driven.attempts,
      failure
    );
  }

  /**
   * Run a request that throws a `GitHubHttpFailure` / `GitHubNetworkFailure`.
   * @example await retry.request('GET /runs', () => send(), { idempotent: true });
   */
  async request<T>(
    label: string,
    attempt: () => Promise<T>,
    options: { readonly idempotent: boolean; readonly signal?: AbortSignal }
  ): Promise<T> {
    const driven = await this.drive<T>(async () => {
      try {
        return { value: await attempt() };
      } catch (failure) {
        return {
          failure,
          decision: judgeRequestFailure(failure, options.idempotent, this.environment.now()),
        };
      }
    }, options.signal);
    if ('value' in driven.attempted) return driven.attempted.value;
    throw this.final(label, driven, driven.attempted.failure);
  }

  /**
   * Read a whole listing again when it is incomplete or moved between pages.
   * Apply it once, around the outermost logical read: a nested listing retry
   * would multiply passes. Any other failure, and the last attempt's, is thrown.
   * @example await retry.listing('actions_caches', () => api.listAllCaches());
   */
  async listing<T>(label: string, read: () => Promise<T>): Promise<T> {
    const driven = await this.drive<T>(async () => {
      try {
        return { value: await read() };
      } catch (failure) {
        const settled = failure instanceof IncompleteListing || failure instanceof UnstableListing;
        return {
          failure,
          decision: settled ? { retry: true, reason: 'unsettled listing' } : NO_RETRY,
        };
      }
    });
    if ('value' in driven.attempted) return driven.attempted.value;
    throw this.final(label, driven, driven.attempted.failure);
  }

  /**
   * Run a `gh` command and return its last result, retrying transient stderr.
   * A result that stays failed is returned, not thrown, so the caller keeps its
   * own error message.
   * @example const result = await retry.ghCommand(() => runner.run(args));
   */
  ghCommand<R extends { readonly exitCode: number; readonly stderr: string }>(
    run: () => R | Promise<R>,
    options: { readonly idempotent?: boolean } = {}
  ): Promise<R> {
    return this.outcome(
      run,
      (result) => (result.exitCode === 0 ? undefined : failureFromGhStderr(result.stderr)),
      options.idempotent ?? true
    );
  }

  /**
   * `ghCommand` for a synchronous caller: the same classification, policy and
   * budget, but the waits block the thread. It returns the last result, so the
   * caller keeps its own error message. Needs an environment with `sleepSync`.
   * @example const result = retry.ghCommandSync(() => runner.run(['api', path]));
   */
  ghCommandSync<R extends { readonly exitCode: number; readonly stderr: string }>(
    run: () => R,
    options: { readonly idempotent?: boolean } = {}
  ): R {
    const { sleepSync } = this.environment;
    if (sleepSync === undefined) {
      throw new Error('GitHubRetry.ghCommandSync: expected a retry environment with sleepSync');
    }
    const idempotent = options.idempotent ?? true;
    for (let number = 1; ; number++) {
      const result = run();
      const failure = result.exitCode === 0 ? undefined : failureFromGhStderr(result.stderr);
      if (failure === undefined) return result;
      const decision = judgeRequestFailure(failure, idempotent, this.environment.now());
      if (!decision.retry) return result;
      const next = this.nextWait(number, decision);
      if ('stoppedBy' in next) return result;
      sleepSync(next.waitMs);
    }
  }

  /**
   * Run something that reports failure as a value (a parsed `gh --include`
   * status) and return the last value. `failureOf` names the failure to
   * classify, or undefined for a result to keep.
   * @example await retry.outcome(() => read(), (r) => r.status >= 400 ? failure : undefined, true);
   */
  async outcome<T>(
    run: () => T | Promise<T>,
    failureOf: (value: T) => GitHubHttpFailure | GitHubNetworkFailure | undefined,
    idempotent: boolean
  ): Promise<T> {
    let last: T | undefined;
    const driven = await this.drive<T>(async () => {
      const value = await run();
      last = value;
      const failure = failureOf(value);
      if (failure === undefined) return { value };
      const decision = judgeRequestFailure(failure, idempotent, this.environment.now());
      return decision.retry ? { failure, decision } : { value };
    });
    // Both a kept value and a final transient failure return what the transport last said.
    return 'value' in driven.attempted ? driven.attempted.value : (last as T);
  }

  /**
   * Run an attempt again after any failure, with the policy's waits, and rethrow
   * the last. For work whose failures are opaque, such as a bounded download.
   * @example await retry.anyFailure('Artifact 7', () => download(), console.error);
   */
  async anyFailure<T>(
    label: string,
    attempt: (number: number) => Promise<T>,
    log: (message: string) => void = console.error
  ): Promise<T> {
    const driven = await this.drive<T>(async (number) => {
      try {
        return { value: await attempt(number) };
      } catch (failure) {
        const message = failure instanceof Error ? failure.message : String(failure);
        log(
          `::warning::${label} attempt ${number}/${this.policy.backoffMs.length + 1} failed: ${message}`
        );
        return { failure, decision: { retry: true, reason: 'attempt failed' } };
      }
    });
    if ('value' in driven.attempted) return driven.attempted.value;
    const failure = driven.attempted.failure;
    throw failure instanceof Error ? failure : new Error(String(failure));
  }
}

const EXCERPT_LIMIT = 200;

/** Render a received body for an error: whitespace collapsed, truncated, never empty. */
function describeReceived(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed === '') return '<empty>';
  return collapsed.length > EXCERPT_LIMIT
    ? `${collapsed.slice(0, EXCERPT_LIMIT)}... (${collapsed.length} chars)`
    : collapsed;
}

/** Which request, and which page of it, a response belongs to. */
export interface ResponseSite {
  readonly request: string;
  readonly page?: number;
}

function describeSite(site: ResponseSite): string {
  return site.page === undefined ? site.request : `${site.request} page ${site.page}`;
}

/**
 * The error for a response whose shape is wrong: it names the request and page,
 * the shape expected and the body received.
 * @example throw malformedResponse({ request: 'GET /issues', page: 2 }, 'a JSON array', body);
 */
export function malformedResponse(site: ResponseSite, expected: string, received: unknown): Error {
  const text = typeof received === 'string' ? received : (JSON.stringify(received) ?? 'undefined');
  return new Error(
    `Invalid ${describeSite(site)}; expected ${expected} | received ${describeReceived(text)}`
  );
}

/** A complete HTTP answer: the body is read inside the retried attempt. */
export interface GitHubReply {
  readonly status: number;
  readonly header: (name: string) => string | undefined;
  readonly text: string;
  /**
   * True when an earlier attempt of this request ended in a network failure or a
   * 5xx: the server may have applied it. A retried DELETE that then answers 404
   * most likely removed the resource itself, so the caller must not call it "already gone".
   */
  readonly afterUncertainAttempt: boolean;
}

/**
 * Parse a reply as JSON, or fail naming the request, page and expected shape.
 * @example const body = parseJsonReply(reply, { request: 'GET /runs/42' }, 'a workflow run object');
 */
export function parseJsonReply(reply: GitHubReply, site: ResponseSite, expected: string): unknown {
  try {
    return JSON.parse(reply.text);
  } catch {
    throw malformedResponse(site, `${expected} as JSON (HTTP ${reply.status})`, reply.text);
  }
}

/**
 * One `fetch` request under the retry policy. `init` builds fresh options for
 * every attempt, so a per-attempt timeout signal restarts. `accept` names the
 * non-2xx statuses the caller handles itself (a 404 for an absent resource).
 * @example await sendGitHubRequest(retry, fetch, { label, url, init, idempotent: true, failure });
 */
export async function sendGitHubRequest(
  retry: GitHubRetry,
  request: GithubFetch,
  options: {
    readonly label: string;
    readonly url: string;
    readonly init: () => RequestInit;
    readonly idempotent: boolean;
    readonly failure: (status: number) => string;
    readonly accept?: (status: number) => boolean;
    readonly signal?: AbortSignal;
  }
): Promise<GitHubReply> {
  let uncertainAttempt = false;
  const reply = await retry.request(
    options.label,
    async () => {
      let response: Response;
      let text: string;
      try {
        response = await request(options.url, options.init());
        text = await response.text();
      } catch (cause) {
        uncertainAttempt = true;
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw new GitHubNetworkFailure(`${options.label} failed before an answer: ${reason}`, {
          cause,
        });
      }
      const answered: GitHubReply = {
        status: response.status,
        header: (name) => response.headers.get(name) ?? undefined,
        text,
        afterUncertainAttempt: false,
      };
      if (response.ok || options.accept?.(response.status)) return answered;
      if (response.status >= 500) uncertainAttempt = true;
      throw new GitHubHttpFailure(
        options.failure(response.status),
        response.status,
        answered.header,
        text
      );
    },
    { idempotent: options.idempotent, signal: options.signal }
  );
  return { ...reply, afterUncertainAttempt: uncertainAttempt };
}
