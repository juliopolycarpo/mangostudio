import {
  ADVISORY_RETRY_POLICY,
  type GithubFetch,
  GitHubRetry,
  parseJsonReply,
  sendGitHubRequest,
} from '../../lib/github-retry';

export interface CacheUsageApi {
  getAllowance(signal: AbortSignal): Promise<unknown>;
  getUsage(signal: AbortSignal): Promise<unknown>;
  listCaches(page: number, signal: AbortSignal): Promise<unknown>;
}

export const CACHE_PAGE_SIZE = 100;
export const STORAGE_LIMIT_FIELD = 'max_cache_size_gb';
// The supported endpoint labels its value GB, not GiB. Keep the API value and
// source in the receipt, and state this conversion wherever we compare bytes.
export const BYTES_PER_GB = 1_000_000_000;

/**
 * Read-only GitHub adapter; the collector bounds fetch and JSON decoding.
 * Each read may retry once after 0.5 s, and the whole report waits at most 1 s
 * in total, so the collector's 3 s per request and 15 s overall stay the real
 * bounds. Retries stop when the collector aborts the request's signal.
 */
export class GithubCacheUsageApi implements CacheUsageApi {
  private readonly root: string;

  constructor(
    repository: string,
    private readonly token: string,
    private readonly request: GithubFetch = fetch,
    private readonly retry: GitHubRetry = new GitHubRetry(ADVISORY_RETRY_POLICY)
  ) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(repository)) {
      throw new Error('Invalid GITHUB_REPOSITORY; expected owner/repo');
    }
    if (!token) throw new Error('GITHUB_TOKEN is required');
    this.root = `https://api.github.com/repos/${repository}/actions`;
  }

  private async json(
    path: string,
    signal: AbortSignal,
    expected: string,
    page?: number
  ): Promise<unknown> {
    const reply = await sendGitHubRequest(this.retry, this.request, {
      label: `GET ${path}`,
      url: `${this.root}${path}`,
      init: () => ({
        method: 'GET',
        redirect: 'error',
        signal,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${this.token}`,
          'x-github-api-version': '2026-03-10',
        },
      }),
      idempotent: true,
      failure: (status) => `GET ${path} returned HTTP ${status}`,
      signal,
    });
    return parseJsonReply(reply, { request: `GET ${path}`, page }, expected);
  }

  getAllowance(signal: AbortSignal): Promise<unknown> {
    return this.json('/cache/storage-limit', signal, 'a storage limit object');
  }

  getUsage(signal: AbortSignal): Promise<unknown> {
    return this.json('/cache/usage', signal, 'a cache usage object');
  }

  listCaches(page: number, signal: AbortSignal): Promise<unknown> {
    if (!Number.isSafeInteger(page) || page < 1) throw new Error('Invalid cache page');
    return this.json(
      `/caches?per_page=${CACHE_PAGE_SIZE}&page=${page}&sort=created_at&direction=asc`,
      signal,
      'a cache listing object',
      page
    );
  }
}
