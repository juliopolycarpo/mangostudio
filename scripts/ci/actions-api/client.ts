// Bounded GitHub REST adapter shared by the cache cleanup scripts. It owns
// authentication, the per-request timeout, pagination with a completeness
// check and the cache entry shape. Callers own which endpoints they touch.
// Requests retry under the shared policy; a listing that stays incomplete or
// unstable throws, and the caller retries the whole read once, outermost
// (`GitHubRetry.listing`), so nothing is deleted from a partial listing.

import {
  type GithubFetch,
  type GitHubReply,
  GitHubRetry,
  IncompleteListing,
  malformedResponse,
  parseJsonReply,
  sendGitHubRequest,
  UnstableListing,
} from '../../lib/github-retry';
import { isJsonRecord } from '../../lib/script-guards';

export interface ActionsCacheEntry {
  readonly id: number;
  readonly key: string;
  readonly ref: string;
  readonly version: string;
  readonly created_at: string;
  /** Present in every live listing; a restore updates it. Older fixtures omit it. */
  readonly last_accessed_at?: string;
  readonly size_in_bytes: number;
}

export type ListingField = 'actions_caches' | 'workflow_runs';

const PAGE_SIZE = 100;
const MAX_PAGES = 100;

/**
 * Validate one entry of an `actions_caches` page.
 * @example const entry = parseCacheEntry(body.actions_caches[0]);
 */
export function parseCacheEntry(value: unknown): ActionsCacheEntry {
  if (
    !isJsonRecord(value) ||
    !Number.isSafeInteger(value.id) ||
    Number(value.id) < 1 ||
    typeof value.key !== 'string' ||
    typeof value.ref !== 'string' ||
    typeof value.version !== 'string' ||
    typeof value.created_at !== 'string' ||
    (value.last_accessed_at !== undefined && typeof value.last_accessed_at !== 'string') ||
    !Number.isSafeInteger(value.size_in_bytes) ||
    Number(value.size_in_bytes) < 1
  ) {
    throw new Error(
      `Invalid cache entry ${JSON.stringify(value)}; expected a positive ID/size, key, ref, version, creation timestamp and an optional string last_accessed_at`
    );
  }
  return value as unknown as ActionsCacheEntry;
}

/**
 * List a repository's caches through one ref-scoped, paginated query and reject
 * a listing whose IDs repeat. Every page is read; one capped page never stands
 * in for the set.
 * @example await listActionsCaches(client, { ref: 'refs/heads/main' });
 */
export async function listActionsCaches(
  client: GithubActionsClient,
  filters: Readonly<Record<string, string>> = {}
): Promise<ActionsCacheEntry[]> {
  const query = new URLSearchParams({
    ...filters,
    sort: 'created_at',
    direction: 'desc',
  });
  const entries = await client.pages(`/caches?${query}`, 'actions_caches', parseCacheEntry);
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
    throw new UnstableListing(
      'Duplicate cache IDs in paginated listing; expected a stable complete listing'
    );
  }
  return entries;
}

/**
 * Delete exactly one cache ID. A 404 on the first attempt means it was already
 * gone and returns false. A 404 after an attempt that timed out or got a 5xx
 * means that earlier attempt reached GitHub and deleted it, so it returns true.
 * @example await deleteActionsCache(client, entry.id);
 */
export async function deleteActionsCache(
  client: GithubActionsClient,
  id: number
): Promise<boolean> {
  if (!Number.isSafeInteger(id) || id < 1)
    throw new Error(`Invalid cache ID ${id}; expected a positive integer`);
  const response = await client.response(`/caches/${id}`, 'DELETE');
  if (response.status === 404) return response.afterUncertainAttempt;
  if (response.status !== 204)
    throw new Error(`DELETE cache ${id} returned ${response.status}; expected 204 or 404`);
  return true;
}

/**
 * Authenticated client for one repository. Paths passed to `response` and
 * `pages` are relative to `/repos/<repository>/actions`.
 * @example const client = new GithubActionsClient('owner/repo', token);
 */
export class GithubActionsClient {
  private readonly repositoryRoot: string;
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
    this.repositoryRoot = `https://api.github.com/repos/${repository}`;
    this.root = `${this.repositoryRoot}/actions`;
  }

  /**
   * One request. A 404 is returned (not thrown) only for DELETE, so "already
   * gone" stays an explicit decision of the deleting caller.
   * @example await client.response('/runs/42');
   */
  response(path: string, method = 'GET'): Promise<GitHubReply> {
    return this.send(`${this.root}${path}`, method, {
      failure: (status) =>
        `${method} ${path} returned ${status}; expected a successful GitHub Actions API response`,
      accept: (status) => method === 'DELETE' && status === 404,
    });
  }

  /**
   * GET one `/actions` resource as JSON, naming the request and the expected
   * shape if the body is not JSON.
   * @example const run = await client.json('/runs/42', 'a workflow run object');
   */
  async json(path: string, expected: string): Promise<unknown> {
    return parseJsonReply(await this.response(path), { request: `GET ${path}` }, expected);
  }

  /**
   * GET one repository resource outside `/actions` (for example a pull
   * request). A 404 is returned so the caller can treat it as absent.
   * @example await client.repositoryResponse('/pulls/42');
   */
  repositoryResponse(path: string): Promise<GitHubReply> {
    return this.send(`${this.repositoryRoot}${path}`, 'GET', {
      failure: (status) =>
        `GET ${path} returned ${status}; expected a successful GitHub API response`,
      accept: (status) => status === 404,
    });
  }

  /** Every method this client sends is a read or a delete of one named ID, so all repeat safely. */
  private send(
    url: string,
    method: string,
    options: { failure: (status: number) => string; accept: (status: number) => boolean }
  ): Promise<GitHubReply> {
    return sendGitHubRequest(this.retry, this.request, {
      label: `${method} ${new URL(url).pathname}`,
      url,
      // A fresh timeout per attempt, so a retry is not born half expired.
      init: () => ({
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${this.token}`,
          'x-github-api-version': '2022-11-28',
        },
      }),
      idempotent: true,
      ...options,
    });
  }

  /**
   * Read every page of a listing and fail unless the entry count equals the
   * reported total.
   * @example await client.pages('/caches?ref=refs/heads/main', 'actions_caches', parseCacheEntry);
   */
  async pages<T>(path: string, field: ListingField, parse: (value: unknown) => T): Promise<T[]> {
    const entries: T[] = [];
    let total: number | undefined;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const site = { request: `GET ${path}`, page };
      const expected = `an object with a nonnegative integer total_count and a "${field}" array`;
      const body = parseJsonReply(
        await this.response(`${path}&per_page=${PAGE_SIZE}&page=${page}`),
        site,
        expected
      );
      if (
        !isJsonRecord(body) ||
        !Number.isSafeInteger(body.total_count) ||
        Number(body.total_count) < 0 ||
        !Array.isArray(body[field])
      ) {
        throw malformedResponse(site, expected, body);
      }
      const count = Number(body.total_count);
      if (total !== undefined && total !== count)
        throw new UnstableListing(
          `Changing ${field} total ${total} -> ${count}; expected a stable complete listing`
        );
      total = count;
      const batch = body[field] as unknown[];
      if (batch.length > PAGE_SIZE)
        throw new Error(
          `Invalid ${field} page length ${batch.length}; expected at most ${PAGE_SIZE}`
        );
      entries.push(...batch.map(parse));
      if (entries.length === total) return entries;
      if (entries.length > total || batch.length < PAGE_SIZE)
        throw new IncompleteListing(
          `Incomplete ${field} listing ${entries.length}/${total}; expected every entry`
        );
    }
    throw new Error(`Exceeded ${MAX_PAGES} ${field} pages; expected a complete bounded listing`);
  }
}
