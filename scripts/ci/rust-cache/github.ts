import { MAIN_CACHE_REF, MAIN_WRITER_EVENTS, RUST_CACHE_WRITERS } from './families';
import type { RustCacheEntry } from './selection';

export interface CacheWriterRun {
  readonly id: number;
  readonly path: string;
  readonly event: string;
  readonly status: string;
  readonly head_branch: string;
  readonly head_repository: { readonly full_name: string };
}

export interface RustCacheApi {
  getRun(id: number): Promise<CacheWriterRun>;
  listCaches(): Promise<RustCacheEntry[]>;
  activeWriters(): Promise<CacheWriterRun[]>;
  deleteCache(id: number): Promise<boolean>;
}

type GithubFetch = (url: string, init: RequestInit) => Promise<Response>;

const WRITER_PATHS = new Set<string>(RUST_CACHE_WRITERS.map((writer) => writer.path));
const WRITER_EVENTS = new Set<string>(MAIN_WRITER_EVENTS);
// Check pre-start states before running, so a pending writer that starts
// during the audit remains visible. These separate reads are not atomic.
const ACTIVE_STATUSES = ['requested', 'pending', 'waiting', 'queued', 'in_progress'];
const PAGE_SIZE = 100;
const MAX_PAGES = 100;

/**
 * Recognize trusted main cache writers, including reusable-workflow callers.
 * @example isMainCacheWriter(run, 'owner/repo');
 */
export function isMainCacheWriter(run: CacheWriterRun, repository: string): boolean {
  return (
    run.head_branch === 'main' &&
    run.head_repository.full_name === repository &&
    WRITER_EVENTS.has(run.event) &&
    WRITER_PATHS.has(run.path.split('@')[0])
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCache(value: unknown): RustCacheEntry {
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
  return value as unknown as RustCacheEntry;
}

function parseRun(value: unknown): CacheWriterRun {
  if (
    !record(value) ||
    !Number.isSafeInteger(value.id) ||
    Number(value.id) < 1 ||
    typeof value.path !== 'string' ||
    typeof value.event !== 'string' ||
    typeof value.status !== 'string' ||
    typeof value.head_branch !== 'string' ||
    !record(value.head_repository) ||
    typeof value.head_repository.full_name !== 'string'
  ) {
    throw new Error(
      `Invalid workflow run ${JSON.stringify(value)}; expected a positive ID, path, event, status, head branch and repository`
    );
  }
  return value as unknown as CacheWriterRun;
}

/**
 * Bounded GitHub cache API adapter. DELETE always names one immutable cache ID.
 * @example const api = new GithubRustCacheApi('owner/repo', token);
 */
export class GithubRustCacheApi implements RustCacheApi {
  private readonly root: string;

  constructor(
    private readonly repository: string,
    private readonly token: string,
    private readonly request: GithubFetch = fetch
  ) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(repository)) {
      throw new Error(`Invalid repository ${JSON.stringify(repository)}; expected owner/repo`);
    }
    if (!token) throw new Error('Invalid GITHUB_TOKEN ""; expected a nonempty Actions token');
    this.root = `https://api.github.com/repos/${repository}/actions`;
  }

  private async response(path: string, method = 'GET'): Promise<Response> {
    const response = await this.request(`${this.root}${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.token}`,
        'x-github-api-version': '2022-11-28',
      },
    });
    if (!response.ok && !(method === 'DELETE' && response.status === 404)) {
      throw new Error(
        `${method} ${path} returned ${response.status}; expected a successful GitHub Actions API response`
      );
    }
    return response;
  }

  private async pages<T>(
    path: string,
    field: 'actions_caches' | 'workflow_runs',
    parse: (value: unknown) => T
  ): Promise<T[]> {
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
        throw new Error(
          `Incomplete ${field} listing ${entries.length}/${total}; expected every entry`
        );
    }
    throw new Error(`Exceeded ${MAX_PAGES} ${field} pages; expected a complete bounded listing`);
  }

  /**
   * Read the triggering run independently of its event payload.
   * @example await api.getRun(42);
   */
  async getRun(id: number): Promise<CacheWriterRun> {
    if (!Number.isSafeInteger(id) || id < 1)
      throw new Error(`Invalid run ID ${id}; expected a positive integer`);
    const run = parseRun(await (await this.response(`/runs/${id}`)).json());
    if (run.id !== id) throw new Error(`Unexpected run ID ${run.id}; expected ${id}`);
    return run;
  }

  /**
   * List every committed Rust cache on main; never use one capped page.
   * @example await api.listCaches();
   */
  async listCaches(): Promise<RustCacheEntry[]> {
    const query = new URLSearchParams({
      ref: MAIN_CACHE_REF,
      key: 'v0-rust-',
      sort: 'created_at',
      direction: 'desc',
    });
    const entries = await this.pages(`/caches?${query}`, 'actions_caches', parseCache);
    if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
      throw new Error(
        'Duplicate cache IDs in paginated listing; expected a stable complete listing'
      );
    }
    return entries;
  }

  /**
   * Audit all active main writers, while ignoring readers such as PR QA Report.
   * @example await api.activeWriters();
   */
  async activeWriters(): Promise<CacheWriterRun[]> {
    const runs = new Map<number, CacheWriterRun>();
    for (const status of ACTIVE_STATUSES) {
      const query = new URLSearchParams({ branch: 'main', status, exclude_pull_requests: 'true' });
      const entries = await this.pages(`/runs?${query}`, 'workflow_runs', parseRun);
      if (new Set(entries.map((run) => run.id)).size !== entries.length) {
        throw new Error(
          `Duplicate workflow run IDs for ${status}; expected a stable complete listing`
        );
      }
      for (const run of entries.filter((run) => isMainCacheWriter(run, this.repository)))
        runs.set(run.id, run);
    }
    return [...runs.values()];
  }

  /**
   * Delete exactly the selected ID, accepting 404 only as already absent.
   * @example await api.deleteCache(oldCache.id);
   */
  async deleteCache(id: number): Promise<boolean> {
    if (!Number.isSafeInteger(id) || id < 1)
      throw new Error(`Invalid cache ID ${id}; expected a positive integer`);
    const response = await this.response(`/caches/${id}`, 'DELETE');
    if (response.status === 404) return false;
    if (response.status !== 204)
      throw new Error(`DELETE cache ${id} returned ${response.status}; expected 204 or 404`);
    return true;
  }
}
