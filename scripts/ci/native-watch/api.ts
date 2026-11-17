// The GitHub surface the native platform watch touches, as one interface so
// tests drive the decisions through a named fake instead of the network.

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

export type GithubFetch = (url: string, init: RequestInit) => Promise<Response>;

const PAGE_SIZE = 100;
const MAX_PAGES = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * REST implementation for one repository, authenticated with the workflow's token.
 * @example const api = new GithubNativeWatchApi('owner/repo', process.env.GITHUB_TOKEN ?? '');
 */
export class GithubNativeWatchApi implements NativeWatchApi {
  private readonly root: string;

  constructor(
    repository: string,
    private readonly token: string,
    private readonly request: GithubFetch = fetch
  ) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(repository)) {
      throw new Error(`Invalid repository ${JSON.stringify(repository)}; expected owner/repo`);
    }
    if (!token) throw new Error('Invalid GITHUB_TOKEN ""; expected a nonempty Actions token');
    this.root = `https://api.github.com/repos/${repository}`;
  }

  private async call(method: string, path: string, payload?: unknown): Promise<unknown> {
    const response = await this.request(`${this.root}${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.token}`,
        'x-github-api-version': '2022-11-28',
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(
        `${method} ${path} returned ${response.status}; expected a successful response`
      );
    }
    return response.status === 204 ? null : response.json();
  }

  /** Every page of an array listing; `pick` extracts the array from the page body. */
  private async pages(path: string, pick: (body: unknown) => unknown[]): Promise<unknown[]> {
    const joiner = path.includes('?') ? '&' : '?';
    const entries: unknown[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = pick(
        await this.call('GET', `${path}${joiner}per_page=${PAGE_SIZE}&page=${page}`)
      );
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
    const body = await this.call('GET', `/actions/workflows/${workflowFile}/runs?${query}`);
    const runs = isRecord(body) ? body.workflow_runs : undefined;
    if (!Array.isArray(runs)) {
      throw new Error(`Invalid workflow runs page ${JSON.stringify(body)}; expected workflow_runs`);
    }
    const sha = isRecord(runs[0]) ? runs[0].head_sha : undefined;
    if (runs.length === 0) return null;
    if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha)) {
      throw new Error(
        `Invalid run head_sha ${JSON.stringify(sha)}; expected 40 lowercase hex characters`
      );
    }
    return sha;
  }

  async listJobs(runId: number): Promise<WorkflowJobResult[]> {
    const entries = await this.pages(`/actions/runs/${runId}/jobs?filter=latest`, (body) =>
      isRecord(body) && Array.isArray(body.jobs) ? body.jobs : []
    );
    return entries.map((entry) => {
      if (!isRecord(entry) || typeof entry.name !== 'string') {
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
    const entries = await this.pages(`/issues?${query}`, (body) =>
      Array.isArray(body) ? body : []
    );
    return entries.flatMap((entry) => {
      if (!isRecord(entry) || !Number.isSafeInteger(entry.number)) {
        throw new Error(`Invalid issue ${JSON.stringify(entry)}; expected a number`);
      }
      // The issues endpoint also lists pull requests.
      if (entry.pull_request !== undefined) return [];
      const user = isRecord(entry.user) ? entry.user.login : undefined;
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
    const entries = await this.pages(`/issues/${issueNumber}/comments`, (body) =>
      Array.isArray(body) ? body : []
    );
    return entries.map((entry) =>
      isRecord(entry) && typeof entry.body === 'string' ? entry.body : ''
    );
  }

  async createIssue(issue: {
    title: string;
    body: string;
    labels: readonly string[];
  }): Promise<number> {
    const created = await this.call('POST', '/issues', issue);
    if (!isRecord(created) || !Number.isSafeInteger(created.number)) {
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
