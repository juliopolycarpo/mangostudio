import type { RetryEnvironment } from '../../lib/github-retry';

/** One scripted answer: an HTTP reply (JSON `body` or raw `text`), or a transport failure. */
export type ScriptedReply =
  | {
      readonly status: number;
      readonly body?: unknown;
      /** Sent verbatim instead of `body`, for a non-JSON answer. */
      readonly text?: string;
      readonly headers?: Record<string, string>;
    }
  | { readonly networkError: string };

/**
 * Replays scripted `fetch` answers in order and records each request. An
 * unscripted request fails loudly, naming the URL.
 * @example http.replies = [{ status: 502 }, { status: 200, body: {} }]; new Api(repo, token, http.request.bind(http))
 */
export class ScriptedGitHubHttp {
  replies: ScriptedReply[] = [];
  calls: Array<{ url: URL; init: RequestInit }> = [];

  request(url: string, init: RequestInit): Promise<Response> {
    this.calls.push({ url: new URL(url), init });
    const reply = this.replies.shift();
    if (!reply) throw new Error(`Unexpected fake GitHub request ${init.method ?? 'GET'} ${url}`);
    if ('networkError' in reply) return Promise.reject(new TypeError(reply.networkError));
    const payload =
      reply.status === 204 ? null : (reply.text ?? JSON.stringify(reply.body ?? null));
    return Promise.resolve(new Response(payload, { status: reply.status, headers: reply.headers }));
  }
}

/** Records the waits a retry asks for and advances a fake clock by them instead of sleeping. */
export class RecordedRetryEnvironment implements RetryEnvironment {
  readonly waits: number[] = [];

  constructor(public clockMs = Date.parse('2026-11-27T12:00:00Z')) {}

  readonly sleep = (milliseconds: number): Promise<void> => {
    this.waits.push(milliseconds);
    this.clockMs += milliseconds;
    return Promise.resolve();
  };

  /** The blocking wait of `ghCommandSync`: recorded in the same list, so a test sees one timeline. */
  readonly sleepSync = (milliseconds: number): void => {
    this.waits.push(milliseconds);
    this.clockMs += milliseconds;
  };

  readonly now = (): number => this.clockMs;
}
