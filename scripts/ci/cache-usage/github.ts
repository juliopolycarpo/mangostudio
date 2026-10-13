export interface CacheUsageApi {
  getAllowance(signal: AbortSignal): Promise<unknown>;
  getUsage(signal: AbortSignal): Promise<unknown>;
  listCaches(page: number, signal: AbortSignal): Promise<unknown>;
}

type GithubFetch = (url: string, init: RequestInit) => Promise<Response>;

export const CACHE_PAGE_SIZE = 100;
export const STORAGE_LIMIT_FIELD = 'max_cache_size_gb';
// The supported endpoint labels its value GB, not GiB. Keep the API value and
// source in the receipt, and state this conversion wherever we compare bytes.
export const BYTES_PER_GB = 1_000_000_000;

/** Read-only GitHub adapter; the collector bounds fetch and JSON decoding. */
export class GithubCacheUsageApi implements CacheUsageApi {
  private readonly root: string;

  constructor(
    repository: string,
    private readonly token: string,
    private readonly request: GithubFetch = fetch
  ) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(repository)) {
      throw new Error('Invalid GITHUB_REPOSITORY; expected owner/repo');
    }
    if (!token) throw new Error('GITHUB_TOKEN is required');
    this.root = `https://api.github.com/repos/${repository}/actions`;
  }

  private async json(path: string, signal: AbortSignal): Promise<unknown> {
    const response = await this.request(`${this.root}${path}`, {
      method: 'GET',
      redirect: 'error',
      signal,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.token}`,
        'x-github-api-version': '2026-03-10',
      },
    });
    if (!response.ok) throw new Error(`GET ${path} returned HTTP ${response.status}`);
    return response.json();
  }

  getAllowance(signal: AbortSignal): Promise<unknown> {
    return this.json('/cache/storage-limit', signal);
  }

  getUsage(signal: AbortSignal): Promise<unknown> {
    return this.json('/cache/usage', signal);
  }

  listCaches(page: number, signal: AbortSignal): Promise<unknown> {
    if (!Number.isSafeInteger(page) || page < 1) throw new Error('Invalid cache page');
    return this.json(
      `/caches?per_page=${CACHE_PAGE_SIZE}&page=${page}&sort=created_at&direction=asc`,
      signal
    );
  }
}
