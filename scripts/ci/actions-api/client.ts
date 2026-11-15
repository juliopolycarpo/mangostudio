// Bounded GitHub REST adapter shared by the cache cleanup scripts. It owns
// authentication, the per-request timeout, pagination with a completeness
// check and the cache entry shape. Callers own which endpoints they touch.

export interface ActionsCacheEntry {
  readonly id: number;
  readonly key: string;
  readonly ref: string;
  readonly version: string;
  readonly created_at: string;
  readonly size_in_bytes: number;
}

export type GithubFetch = (url: string, init: RequestInit) => Promise<Response>;
export type ListingField = 'actions_caches' | 'workflow_runs';

const PAGE_SIZE = 100;
const MAX_PAGES = 100;

class IncompleteListing extends Error {
  constructor(
    readonly field: ListingField,
    entries: number,
    total: number
  ) {
    super(`Incomplete ${field} listing ${entries}/${total}; expected every entry`);
  }
}

/**
 * Retry once from the start when a listing's row count disagrees with its total.
 * @example await retryIncompleteListing('actions_caches', () => api.listCaches());
 */
export async function retryIncompleteListing<T>(
  field: ListingField,
  read: () => Promise<T>
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof IncompleteListing) || error.field !== field) throw error;
    return read();
  }
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate one entry of an `actions_caches` page.
 * @example const entry = parseCacheEntry(body.actions_caches[0]);
 */
function parseCacheEntry(value: unknown): ActionsCacheEntry {
  if (
    !record(value) ||
    !Number.isSafeInteger(value.id) ||
    Number(value.id) < 1 ||
    typeof value.key !== 'string' ||
    typeof value.ref !== 'string' ||
    typeof value.version !== 'string' ||
    typeof value.created_at !== 'string' ||
    !Number.isSafeInteger(value.size_in_bytes) ||
    Number(value.size_in_bytes) < 1
  ) {
    throw new Error(
      `Invalid cache entry ${JSON.stringify(value)}; expected a positive ID/size, key, ref, version and creation timestamp`
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
  const query = new URLSearchParams({ ...filters, sort: 'created_at', direction: 'desc' });
  const entries = await client.pages(`/caches?${query}`, 'actions_caches', parseCacheEntry);
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
    throw new Error('Duplicate cache IDs in paginated listing; expected a stable complete listing');
  }
  return entries;
}

/**
 * Delete exactly one cache ID. 404 means it is already gone and returns false.
 * @example await deleteActionsCache(client, entry.id);
 */
export async function deleteActionsCache(
  client: GithubActionsClient,
  id: number
): Promise<boolean> {
  if (!Number.isSafeInteger(id) || id < 1)
    throw new Error(`Invalid cache ID ${id}; expected a positive integer`);
  const response = await client.response(`/caches/${id}`, 'DELETE');
  if (response.status === 404) return false;
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
    private readonly request: GithubFetch = fetch
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
  async response(path: string, method = 'GET'): Promise<Response> {
    const response = await this.send(`${this.root}${path}`, method);
    if (!response.ok && !(method === 'DELETE' && response.status === 404)) {
      throw new Error(
        `${method} ${path} returned ${response.status}; expected a successful GitHub Actions API response`
      );
    }
    return response;
  }

  /**
   * GET one repository resource outside `/actions` (for example a pull
   * request). A 404 is returned so the caller can treat it as absent.
   * @example await client.repositoryResponse('/pulls/42');
   */
  async repositoryResponse(path: string): Promise<Response> {
    const response = await this.send(`${this.repositoryRoot}${path}`, 'GET');
    if (!response.ok && response.status !== 404) {
      throw new Error(
        `GET ${path} returned ${response.status}; expected a successful GitHub API response`
      );
    }
    return response;
  }

  private send(url: string, method: string): Promise<Response> {
    return this.request(url, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.token}`,
        'x-github-api-version': '2022-11-28',
      },
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
      const response = await this.response(`${path}&per_page=${PAGE_SIZE}&page=${page}`);
      const body: unknown = await response.json();
      if (
        !record(body) ||
        !Number.isSafeInteger(body.total_count) ||
        Number(body.total_count) < 0 ||
        !Array.isArray(body[field])
      ) {
        throw new Error(`Invalid ${field} page ${page}; expected total_count and an entries array`);
      }
      const count = Number(body.total_count);
      if (total !== undefined && total !== count)
        throw new Error(
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
        throw new IncompleteListing(field, entries.length, total);
    }
    throw new Error(`Exceeded ${MAX_PAGES} ${field} pages; expected a complete bounded listing`);
  }
}
