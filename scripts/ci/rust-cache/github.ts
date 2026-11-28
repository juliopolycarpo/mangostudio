import type { GithubFetch, GitHubRetry } from '../../lib/github-retry';
import { isJsonRecord } from '../../lib/script-guards';
import { deleteActionsCache, GithubActionsClient, listActionsCaches } from '../actions-api/client';
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

const WRITER_PATHS = new Set<string>(RUST_CACHE_WRITERS.map((writer) => writer.path));
const WRITER_EVENTS = new Set<string>(MAIN_WRITER_EVENTS);
// Check pre-start states before running, so a pending writer that starts
// during the audit remains visible. These separate reads are not atomic.
const ACTIVE_STATUSES = ['requested', 'pending', 'waiting', 'queued', 'in_progress'];

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

function parseRun(value: unknown): CacheWriterRun {
  if (
    !isJsonRecord(value) ||
    !Number.isSafeInteger(value.id) ||
    Number(value.id) < 1 ||
    typeof value.path !== 'string' ||
    typeof value.event !== 'string' ||
    typeof value.status !== 'string' ||
    typeof value.head_branch !== 'string' ||
    !isJsonRecord(value.head_repository) ||
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
  private readonly client: GithubActionsClient;

  constructor(
    private readonly repository: string,
    token: string,
    request?: GithubFetch,
    retry?: GitHubRetry
  ) {
    this.client = new GithubActionsClient(repository, token, request, retry);
  }

  /**
   * Read the triggering run independently of its event payload.
   * @example await api.getRun(42);
   */
  async getRun(id: number): Promise<CacheWriterRun> {
    if (!Number.isSafeInteger(id) || id < 1)
      throw new Error(`Invalid run ID ${id}; expected a positive integer`);
    const run = parseRun(await this.client.json(`/runs/${id}`, 'a workflow run object'));
    if (run.id !== id) throw new Error(`Unexpected run ID ${run.id}; expected ${id}`);
    return run;
  }

  /**
   * List every committed Rust cache on main; never use one capped page.
   * @example await api.listCaches();
   */
  listCaches(): Promise<RustCacheEntry[]> {
    return listActionsCaches(this.client, { ref: MAIN_CACHE_REF, key: 'v0-rust-' });
  }

  /**
   * Audit active main writers and ignore readers such as PR QA Report. One
   * pass: an incomplete listing throws, and the cleanup restarts the audit
   * together with the cache revalidation it guards, so no layer repeats it twice.
   * @example await api.activeWriters();
   */
  async activeWriters(): Promise<CacheWriterRun[]> {
    const runs = new Map<number, CacheWriterRun>();
    for (const status of ACTIVE_STATUSES) {
      const query = new URLSearchParams({ branch: 'main', status, exclude_pull_requests: 'true' });
      const entries = await this.client.pages(`/runs?${query}`, 'workflow_runs', parseRun);
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
  deleteCache(id: number): Promise<boolean> {
    return deleteActionsCache(this.client, id);
  }
}
