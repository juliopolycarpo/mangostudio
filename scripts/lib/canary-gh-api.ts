// The synchronous GitHub read boundary of the canary qualifiers. Their libraries
// (`qualifyCanarySource`, `resolveCanaryPromotionSource`, the CodeQL coverage
// proof) take synchronous `get`/`list` ports shared with git-backed callers, so
// the retry runs through `GitHubRetry.ghCommandSync`: the same classification,
// policy and budget as `CanaryGitHub`, with blocking waits.
import { describeGhStderr, type GhCommandRunner, ghRunner } from './canary-github';
import { GitHubRetry, malformedResponse, STANDARD_RETRY_POLICY } from './github-retry';

/** Structurally satisfies `CanaryValidationApi`, `CanaryPromotionApi` and `CanaryCoverageApi`. */
export interface CanaryGhReadApi {
  get(path: string): unknown;
  list(path: string, key: string): readonly unknown[];
}

/**
 * Read GitHub through `gh api`, retrying transient failures (5xx, 429, a rate
 * limited 403, a transport reset) under the standard policy. Pass one `retry` per
 * process: every read then spends the same 60 s wait budget instead of 60 s each.
 * A persistent failure names the request, the gh exit code and the redacted stderr.
 * @example const api = createCanaryGhApi(); api.get('repos/owner/repo/actions/workflows/ci.yml');
 */
export function createCanaryGhApi(
  runner: GhCommandRunner = ghRunner,
  retry: GitHubRetry = new GitHubRetry(STANDARD_RETRY_POLICY)
): CanaryGhReadApi {
  const read = (request: string, args: readonly string[]): string => {
    const result = retry.ghCommandSync(() => runner.run(args));
    if (result.exitCode !== 0) {
      throw new Error(
        `GitHub API ${request}: expected successful gh exit 0 | received: exit ${result.exitCode} | stderr: ${describeGhStderr(result.stderr)}`
      );
    }
    return Buffer.from(result.stdout).toString('utf8');
  };
  return {
    get(path) {
      const text = read(`GET ${path}`, ['api', path]);
      try {
        return JSON.parse(text);
      } catch {
        throw malformedResponse({ request: `GET ${path}` }, 'a JSON document', text);
      }
    },
    list(path, key) {
      const site = { request: `paginated GET ${path}` };
      // The transport failure is not named "paginated": canaryApprovalChildFailure
      // files that word under incomplete metadata, not under a failed read.
      const text = read(`GET ${path} (all pages)`, ['api', '--paginate', '--slurp', path]);
      let pages: unknown;
      try {
        pages = JSON.parse(text);
      } catch {
        throw malformedResponse(site, 'a JSON page collection', text);
      }
      if (!Array.isArray(pages) || pages.length === 0) {
        throw malformedResponse(site, 'nonempty paginated array', text);
      }
      let expectedCount: number | undefined;
      const items = pages.flatMap((page: unknown) => {
        if (
          !page ||
          typeof page !== 'object' ||
          !Array.isArray((page as Record<string, unknown>)[key])
        ) {
          throw malformedResponse(site, `page.${key} array`, page);
        }
        const count = (page as Record<string, unknown>).total_count;
        if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
          throw malformedResponse(site, 'page.total_count nonnegative safe integer', count);
        }
        if (expectedCount !== undefined && count !== expectedCount) {
          throw malformedResponse(site, `stable total_count ${expectedCount}`, count);
        }
        expectedCount = count;
        return (page as Record<string, unknown>)[key] as unknown[];
      });
      if (items.length !== expectedCount) {
        throw malformedResponse(
          site,
          `complete ${key} collection (${expectedCount} entries)`,
          items.length
        );
      }
      return items;
    },
  };
}
