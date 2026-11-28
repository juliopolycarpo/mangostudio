import { type GithubFetch, type GitHubRetry, parseJsonReply } from '../../lib/github-retry';
import { isJsonRecord } from '../../lib/script-guards';
import {
  type ActionsCacheEntry,
  deleteActionsCache,
  GithubActionsClient,
  listActionsCaches,
} from '../actions-api/client';
import { type PullRequestState } from './selection';

export interface PullRequestCacheApi {
  /** Caches saved under one exact ref. */
  listCachesOnRef(ref: string): Promise<ActionsCacheEntry[]>;
  /** Every cache in the repository, on any ref. */
  listAllCaches(): Promise<ActionsCacheEntry[]>;
  /** `undefined` when GitHub has no such pull request. */
  pullRequestState(pullRequest: number): Promise<PullRequestState | undefined>;
  /** `false` when the cache was already gone. */
  deleteCache(id: number): Promise<boolean>;
}

/**
 * GitHub adapter for pull request cache cleanup. DELETE names one cache ID.
 * @example const api = new GithubPullRequestCacheApi('owner/repo', token);
 */
export class GithubPullRequestCacheApi implements PullRequestCacheApi {
  private readonly client: GithubActionsClient;

  constructor(repository: string, token: string, request?: GithubFetch, retry?: GitHubRetry) {
    this.client = new GithubActionsClient(repository, token, request, retry);
  }

  listCachesOnRef(ref: string): Promise<ActionsCacheEntry[]> {
    return listActionsCaches(this.client, { ref });
  }

  listAllCaches(): Promise<ActionsCacheEntry[]> {
    return listActionsCaches(this.client);
  }

  async pullRequestState(pullRequest: number): Promise<PullRequestState | undefined> {
    if (!Number.isSafeInteger(pullRequest) || pullRequest < 1)
      throw new Error(`Invalid pull request number ${pullRequest}; expected a positive integer`);
    const response = await this.client.repositoryResponse(`/pulls/${pullRequest}`);
    if (response.status === 404) return undefined;
    const body = parseJsonReply(
      response,
      { request: `GET /pulls/${pullRequest}` },
      'a pull request object'
    );
    if (!isJsonRecord(body) || (body.state !== 'open' && body.state !== 'closed')) {
      throw new Error(
        `Invalid pull request ${pullRequest} state ${JSON.stringify(isJsonRecord(body) ? body.state : body)}; expected "open" or "closed"`
      );
    }
    return body.state;
  }

  deleteCache(id: number): Promise<boolean> {
    return deleteActionsCache(this.client, id);
  }
}
