// The GitHub surface the native platform watch touches, as one interface so
// tests drive the decisions through a named fake instead of the network.

import {
  type GithubFetch,
  GitHubRetry,
  malformedResponse,
  parseJsonReply,
  sendGitHubRequest,
} from '../../lib/github-retry';
import { isJsonRecord } from '../../lib/script-guards';

export interface TrackingIssue {
  readonly number: number;
  readonly body: string;
  readonly author: string;
}

export interface WorkflowJobResult {
  readonly name: string;
  /** GitHub's conclusion; null while the job is still running (the reporting job itself). */
  readonly conclusion: string | null;
}

export interface NativeWatchApi {
  /** Head SHA of the newest successful run of `workflowFile` started by `schedule` on `branch`, or null. */
  lastSuccessfulScheduledSha(workflowFile: string, branch: string): Promise<string | null>;
  listJobs(runId: number): Promise<WorkflowJobResult[]>;
  /** Open issues carrying `label`, pull requests excluded, every page read. */
  listOpenIssues(label: string): Promise<TrackingIssue[]>;
  listIssueCommentBodies(issueNumber: number): Promise<string[]>;
  createIssue(issue: { title: string; body: string; labels: readonly string[] }): Promise<number>;
  commentOnIssue(issueNumber: number, body: string): Promise<void>;
  closeIssue(issueNumber: number): Promise<void>;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 10;

/**
 * Per-attempt timeout. The gate and report jobs have 9 minutes, of which Bun
 * setup may take four, and a failed attempt costs its whole timeout. With the
 * standard policy (60 s of waiting, 5 s at the least per retry) a run makes at
 * most 12 retried attempts plus one final one, so every request chain ends in
 * 13 * 10 s + 60 s = 190 s: inside the 5 minutes left, with room for checkout.
 * The longest chain, a failing report (open issues, jobs, comments, one
 * comment POST), is four requests; a POST is never retried after a timeout.
 */
export const NATIVE_WATCH_REQUEST_TIMEOUT_MS = 10_000;
// Close is a PATCH to a fixed state, so repeating it is safe; creating an issue
// or a comment is not, and is only retried when GitHub rejected it for a rate limit.
const REPEATABLE_METHODS = new Set(['GET', 'PATCH']);

/**
 * REST implementation for one repository, authenticated with the workflow's token.
 * Reads and the close PATCH retry transient failures under the standard policy
 * (waits total at most 60 s and each attempt times out after 10 s, so a run
 * ends within 190 s even if every attempt fails); a malformed listing throws
 * instead of reading as empty.
 * @example const api = new GithubNativeWatchApi('owner/repo', process.env.GITHUB_TOKEN ?? '');
 */
export class GithubNativeWatchApi implements NativeWatchApi {
  private readonly root: string;

  constructor(
    repository: string,
    private readonly token: string,
    private readonly request: GithubFetch = fetch,
    private readonly retry: GitHubRetry = new GitHubRetry()
  ) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(repository)) {
      throw new Error(`Invalid repository ${JSON.stringify(repository)}; expected owner/repo`);
    }
    if (!token) throw new Error('Invalid GITHUB_TOKEN ""; expected a nonempty Actions token');
    this.root = `https://api.github.com/repos/${repository}`;
  }

  private async call(
    method: string,
    path: string,
    payload?: unknown,
    shape: { readonly expected: string; readonly page?: number } = { expected: 'a JSON value' }
  ): Promise<unknown> {
    const reply = await sendGitHubRequest(this.retry, this.request, {
      label: `${method} ${path}`,
      url: `${this.root}${path}`,
      init: () => ({
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(NATIVE_WATCH_REQUEST_TIMEOUT_MS),
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${this.token}`,
          'x-github-api-version': '2022-11-28',
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      }),
      idempotent: REPEATABLE_METHODS.has(method),
      failure: (status) => `${method} ${path} returned ${status}; expected a successful response`,
    });
    return reply.status === 204
      ? null
      : parseJsonReply(reply, { request: `${method} ${path}`, page: shape.page }, shape.expected);
  }

  /** Every page of an array listing; `field` names the array inside each page object, when there is one. */
  private async pages(path: string, field?: string): Promise<unknown[]> {
    const joiner = path.includes('?') ? '&' : '?';
    const entries: unknown[] = [];
    const expected = field === undefined ? 'a JSON array' : `an object with a "${field}" array`;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = await this.call(
        'GET',
        `${path}${joiner}per_page=${PAGE_SIZE}&page=${page}`,
        undefined,
        { expected, page }
      );
      const batch = field === undefined ? body : isJsonRecord(body) ? body[field] : undefined;
      // A body of the wrong shape is not an empty listing: reading it as one
      // would close nothing on a green run and open a duplicate on a red one.
      if (!Array.isArray(batch)) {
        throw malformedResponse({ request: `GET ${path}`, page }, expected, body);
      }
      entries.push(...batch);
      if (batch.length < PAGE_SIZE) return entries;
    }
    throw new Error(`Exceeded ${MAX_PAGES} pages of ${path}; expected a bounded listing`);
  }

  async lastSuccessfulScheduledSha(workflowFile: string, branch: string): Promise<string | null> {
    const query = new URLSearchParams({
      event: 'schedule',
      status: 'success',
      branch,
      per_page: '1',
    });
    const path = `/actions/workflows/${workflowFile}/runs?${query}`;
    const expected = 'an object with a "workflow_runs" array';
    const body = await this.call('GET', path, undefined, { expected });
    const runs = isJsonRecord(body) ? body.workflow_runs : undefined;
    if (!Array.isArray(runs)) throw malformedResponse({ request: `GET ${path}` }, expected, body);
    const sha = isJsonRecord(runs[0]) ? runs[0].head_sha : undefined;
    if (runs.length === 0) return null;
    if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha)) {
      throw new Error(
        `Invalid run head_sha ${JSON.stringify(sha)}; expected 40 lowercase hex characters`
      );
    }
    return sha;
  }

  async listJobs(runId: number): Promise<WorkflowJobResult[]> {
    const entries = await this.pages(`/actions/runs/${runId}/jobs?filter=latest`, 'jobs');
    return entries.map((entry) => {
      if (!isJsonRecord(entry) || typeof entry.name !== 'string') {
        throw new Error(`Invalid job ${JSON.stringify(entry)}; expected a name`);
      }
      return {
        name: entry.name,
        conclusion: typeof entry.conclusion === 'string' ? entry.conclusion : null,
      };
    });
  }

  async listOpenIssues(label: string): Promise<TrackingIssue[]> {
    const query = new URLSearchParams({ state: 'open', labels: label });
    const entries = await this.pages(`/issues?${query}`);
    return entries.flatMap((entry) => {
      if (!isJsonRecord(entry) || !Number.isSafeInteger(entry.number)) {
        throw new Error(`Invalid issue ${JSON.stringify(entry)}; expected a number`);
      }
      // The issues endpoint also lists pull requests.
      if (entry.pull_request !== undefined) return [];
      const user = isJsonRecord(entry.user) ? entry.user.login : undefined;
      return [
        {
          number: Number(entry.number),
          body: typeof entry.body === 'string' ? entry.body : '',
          author: typeof user === 'string' ? user : '',
        },
      ];
    });
  }

  async listIssueCommentBodies(issueNumber: number): Promise<string[]> {
    const entries = await this.pages(`/issues/${issueNumber}/comments`);
    return entries.map((entry) =>
      isJsonRecord(entry) && typeof entry.body === 'string' ? entry.body : ''
    );
  }

  async createIssue(issue: {
    title: string;
    body: string;
    labels: readonly string[];
  }): Promise<number> {
    const created = await this.call('POST', '/issues', issue, {
      expected: 'a created issue object',
    });
    if (!isJsonRecord(created) || !Number.isSafeInteger(created.number)) {
      throw new Error(`Invalid created issue ${JSON.stringify(created)}; expected a number`);
    }
    return Number(created.number);
  }

  async commentOnIssue(issueNumber: number, body: string): Promise<void> {
    await this.call('POST', `/issues/${issueNumber}/comments`, { body });
  }

  async closeIssue(issueNumber: number): Promise<void> {
    await this.call('PATCH', `/issues/${issueNumber}`, {
      state: 'closed',
      state_reason: 'completed',
    });
  }
}
