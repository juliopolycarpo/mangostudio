import type { GitHubNetworkFailure } from './github-retry';
import {
  failureFromGhStderr,
  GitHubHttpFailure,
  GitHubRetry,
  IncompleteListing,
  malformedResponse,
  STANDARD_RETRY_POLICY,
  UnstableListing,
} from './github-retry';
import { requireJsonRecord, requirePositiveSafeInteger } from './script-guards';

/** Captured gh result; credentials stay in gh's normal environment and keychain. */
export interface GhCommandResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: string;
}

/** Project-owned command boundary. Example: new CanaryGitHub('owner/repo', namedFakeRunner). */
export interface GhCommandRunner {
  run(args: readonly string[]): GhCommandResult;
}

interface GitHubResponse<T> {
  readonly status: number;
  readonly body: T;
}

const ghRunner: GhCommandRunner = {
  run(args) {
    const result = Bun.spawnSync({
      cmd: ['gh', ...args],
      stdin: 'ignore',
      timeout: 15 * 60_000,
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr.toString(),
    };
  },
};

const STDERR_LIMIT = 300;

/**
 * Render gh stderr for an error message without leaking secrets: URLs (signed
 * asset links carry query tokens) and credential shapes are redacted, whitespace
 * is collapsed and the text is truncated.
 * Example: describeGhStderr('gh: Bad Gateway (HTTP 502)') === 'gh: Bad Gateway (HTTP 502)'.
 */
export function describeGhStderr(stderr: string): string {
  const text = stderr
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>')
    .replace(/\b(?:gh[pousr]_|github_pat_)\w+/g, '<token>')
    .replace(/\b(Bearer|token|Basic)\s+\S+/gi, '$1 <redacted>')
    .replace(/\s+/g, ' ')
    .trim();
  if (text === '') return '<empty>';
  return text.length > STDERR_LIMIT ? `${text.slice(0, STDERR_LIMIT)}...` : text;
}

/** GitHub reads and controlled CLI writes for canary recovery. Example: const client = new CanaryGitHub('owner/repo'). */
export class CanaryGitHub {
  private readonly base: string;
  // Reads retry transient failures and unsettled listings under the standard
  // policy: three attempts, 5 s then 10 s apart, at most 60 s of waiting per
  // client. Writes (`writeCommand`) never retry.
  private readonly retry: GitHubRetry;

  constructor(
    repository: string,
    private readonly runner: GhCommandRunner = ghRunner,
    sleep?: (milliseconds: number) => Promise<void>
  ) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
      throw new Error(`Invalid GitHub repository: ${repository}; expected owner/repository`);
    }
    this.base = `repos/${repository}`;
    this.retry = new GitHubRetry(
      STANDARD_RETRY_POLICY,
      sleep ? { sleep, now: () => Date.now() } : undefined
    );
  }

  /**
   * Read a published release or a draft with this pending tag. GitHub's tag
   * endpoint only finds published releases; complete absence requires credentials
   * with push access so the paginated fallback also includes drafts.
   * Example: await client.getRelease('v1.2.3-canary.abcdef0').
   */
  async getRelease(tag: string): Promise<GitHubResponse<unknown>> {
    const published = await this.getJson(`${this.base}/releases/tags/${encodeURIComponent(tag)}`);
    if (published.status !== 404) return published;
    const releases = await this.list(`${this.base}/releases?per_page=100`);
    const matches: Record<string, unknown>[] = [];
    for (const entry of releases) {
      const release = requireJsonRecord(entry, 'release listing entry');
      requirePositiveSafeInteger(release.id, 'release listing ID');
      if (
        typeof release.tag_name !== 'string' ||
        release.tag_name.length === 0 ||
        typeof release.draft !== 'boolean'
      ) {
        throw new Error(
          `GitHub release listing: expected tag_name string and draft boolean; received tag_name=${JSON.stringify(release.tag_name)} draft=${JSON.stringify(release.draft)}`
        );
      }
      if (release.tag_name === tag) matches.push(release);
    }
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous GitHub release tag ${JSON.stringify(tag)}: expected at most one release; received ${matches.length}`
      );
    }
    const release = matches[0];
    return release ? { status: 200, body: release } : published;
  }

  /** Peel a tag to its full commit SHA; only a genuinely absent ref returns404. Example: await client.resolveTag('v1.2.3'). */
  async resolveTag(tag: string): Promise<GitHubResponse<unknown>> {
    const response = await this.getJson(`${this.base}/git/ref/tags/${encodeURIComponent(tag)}`);
    if (response.status === 404) return response;
    requireOk(response.status, 'tag reference');
    let current = requireJsonRecord(response.body, 'tag reference').object;
    const seen = new Set<string>();
    for (let depth = 0; depth < 8; depth += 1) {
      const target = requireJsonRecord(current, 'tag target');
      if (typeof target.sha !== 'string' || !/^[a-f0-9]{40}$/.test(target.sha)) {
        throw new Error(
          `Invalid tag target SHA: ${String(target.sha)}; expected full lowercase SHA`
        );
      }
      if (target.type === 'commit') return { status: 200, body: target.sha };
      if (target.type !== 'tag') {
        throw new Error(`Invalid tag target type: ${String(target.type)}; expected commit or tag`);
      }
      if (seen.has(target.sha)) throw new Error(`Cyclic annotated tag: ${target.sha}`);
      seen.add(target.sha);
      const annotation = await this.getJson(`${this.base}/git/tags/${target.sha}`);
      requireOk(annotation.status, 'annotated tag');
      current = requireJsonRecord(annotation.body, 'annotated tag').object;
    }
    throw new Error('Annotated tag depth exceeds8; expected bounded tag chain ending in commit');
  }

  /** Read every asset page before deciding release completeness. Example: await client.listAssets(123). */
  async listAssets(releaseId: number): Promise<readonly unknown[]> {
    requirePositiveSafeInteger(releaseId, 'release ID');
    return this.list(`${this.base}/releases/${releaseId}/assets?per_page=100`);
  }

  /** Read repository JSON with actual status; callers must reject non200/non404 responses. Example: await client.getJson('repos/owner/repo/actions/runs/123'). */
  async getJson(path: string): Promise<GitHubResponse<unknown>> {
    const response = await Promise.resolve(this.read(path));
    const text = Buffer.from(response.body).toString('utf8');
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw malformedResponse(
        { request: `GET ${path}` },
        `valid JSON for HTTP${response.status}`,
        text
      );
    }
    return { status: response.status, body };
  }

  /** Read binary repository evidence while retaining actual HTTP status. Example: await client.readBytes('repos/owner/repo/actions/artifacts/123/zip'). */
  async readBytes(path: string, accept?: string): Promise<GitHubResponse<Uint8Array>> {
    return await Promise.resolve(this.read(path, accept));
  }

  /** Download a small release evidence asset without rendering bytes or credentials. Example: await client.readAsset(456). */
  async readAsset(assetId: number): Promise<GitHubResponse<Uint8Array>> {
    requirePositiveSafeInteger(assetId, 'asset ID');
    return await Promise.resolve(
      this.read(`${this.base}/releases/assets/${assetId}`, 'application/octet-stream')
    );
  }

  /** Read paginated array responses, or counted object collections. Example: await client.list('repos/owner/repo/releases?per_page=100'). */
  async list(path: string, key?: string): Promise<readonly unknown[]> {
    this.requireRepositoryPath(path);
    // One level of listing retry around the whole read, and the transient-
    // failure retry inside it: both spend the same wait budget.
    return this.retry.listing(`GET ${path}`, () => this.readListing(path, key));
  }

  private async readListing(path: string, key?: string): Promise<readonly unknown[]> {
    // A paginated read restarts from page one: a late 5xx must not discard earlier pages for good.
    const result = await this.retry.ghCommand(() =>
      this.runner.run(['api', '--paginate', '--slurp', path])
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `GitHub paginated read: expected successful gh exit | received: exit ${result.exitCode} for ${path} | stderr: ${describeGhStderr(result.stderr)}`
      );
    }
    const text = Buffer.from(result.stdout).toString('utf8');
    const site = { request: `paginated GET ${path}` };
    let pages: unknown;
    try {
      pages = JSON.parse(text);
    } catch {
      throw malformedResponse(site, 'JSON page collection', text);
    }
    if (!Array.isArray(pages) || pages.length === 0) {
      throw malformedResponse(site, 'nonempty array of pages', text);
    }
    let total: number | undefined;
    const entries: unknown[] = [];
    for (const page of pages) {
      let values: unknown;
      if (key === undefined) {
        values = page;
      } else {
        const collection = requireJsonRecord(page, 'GitHub page');
        if (!Number.isSafeInteger(collection.total_count) || Number(collection.total_count) < 0) {
          throw new Error(
            `GitHub page total_count: expected nonnegative safe integer; received ${String(collection.total_count)}`
          );
        }
        if (total !== undefined && total !== collection.total_count) {
          throw new UnstableListing(
            `GitHub page total_count changed: expected ${total}; received ${String(collection.total_count)}`
          );
        }
        total = Number(collection.total_count);
        values = collection[key];
      }
      if (!Array.isArray(values))
        throw new Error('GitHub page: expected complete array collection');
      entries.push(...values);
    }
    if (total !== undefined && entries.length !== total) {
      throw new IncompleteListing(
        `Incomplete GitHub pages: expected ${total} entries; received ${entries.length}`
      );
    }
    const seen = new Set<number>();
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || !('id' in entry)) continue;
      requirePositiveSafeInteger(entry.id, 'paginated entry ID');
      // An entry shifting to the next page while the listing is being read shows up as a repeat.
      if (seen.has(Number(entry.id)))
        throw new UnstableListing(`Duplicate GitHub paginated entry ID: ${String(entry.id)}`);
      seen.add(Number(entry.id));
    }
    return entries;
  }

  /** Run a publisher-owned gh command, preserving its result and rejecting failures. Example: client.writeCommand(['release','upload',tag,path,'--repo','owner/repo']). */
  writeCommand(args: readonly string[]): GhCommandResult {
    if (args.length === 0) throw new Error('GitHub command: expected nonempty argument list');
    const result = this.runner.run(args);
    if (result.exitCode !== 0) {
      // Do not echo arbitrary CLI output: a transport diagnostic can include a
      // signed asset URL or an inherited credential.
      // Only a bare status code is safe to surface; gh prints it as "HTTP 422".
      const status = /\bHTTP (\d{3})\b/.exec(result.stderr)?.[1];
      throw new Error(
        `GitHub command failed: expected exit0; received ${result.exitCode}${status ? ` (HTTP ${status})` : ''}`
      );
    }
    return result;
  }

  /**
   * One read with its status. A 5xx, a 429 or a rate-limited 403 is read again
   * under the policy, honoring Retry-After from the `--include` headers; the
   * last answer is returned either way, so callers keep deciding on the status.
   */
  private async read(path: string, accept?: string): Promise<GitHubResponse<Uint8Array>> {
    this.requireRepositoryPath(path);
    const args = ['api', '--include', ...(accept ? ['--header', `Accept: ${accept}`] : []), path];
    const attempt = (): ReadAttempt => {
      const result = this.runner.run(args);
      try {
        return { parsed: this.parseResponse(result) };
      } catch (error) {
        // gh printed no status line at all: a transport failure (reset, timeout)
        // names itself on stderr and is read again. Anything else still fails
        // closed with the parse error.
        const failure =
          result.exitCode !== 0 && !startsWithHttpStatusLine(result.stdout)
            ? failureFromGhStderr(result.stderr)
            : undefined;
        if (failure === undefined) throw error;
        return { unanswered: error, failure };
      }
    };
    const last = await this.retry.outcome(
      attempt,
      (read) => {
        if ('failure' in read) return read.failure;
        const { parsed } = read;
        return parsed.status >= 400
          ? new GitHubHttpFailure(
              `HTTP ${parsed.status}`,
              parsed.status,
              (name) => parsed.headers.get(name),
              Buffer.from(parsed.body.subarray(0, 1_000)).toString('utf8')
            )
          : undefined;
      },
      true
    );
    if ('failure' in last) throw last.unanswered;
    return { status: last.parsed.status, body: last.parsed.body };
  }

  private parseResponse(result: GhCommandResult): GitHubResponse<Uint8Array> & {
    readonly headers: ReadonlyMap<string, string>;
  } {
    const bytes = Buffer.from(result.stdout);
    const statusLineEnd = bytes.indexOf(10);
    const statusLine = bytes.subarray(0, statusLineEnd).toString('ascii').trimEnd();
    const match = /^HTTP\/\d+(?:\.\d+)? ([1-5]\d{2})(?: [^\r\n]*)?$/.exec(statusLine);
    if (statusLineEnd < 0 || !match) {
      throw new Error(
        `GitHub response: expected HTTP status headers; received gh exit${result.exitCode}`
      );
    }
    const separator = /\r?\n\r?\n/.exec(bytes.toString('latin1'));
    if (!separator || separator.index < statusLineEnd - 1) {
      throw new Error('GitHub response: expected complete HTTP header separator');
    }
    const status = Number(match[1]);
    if (status !== 200 && status < 400)
      throw new Error(`GitHub response: expected HTTP200 or error status; received HTTP${status}`);
    if ((result.exitCode !== 0 && status < 400) || (result.exitCode === 0 && status >= 400)) {
      throw new Error(`GitHub response: inconsistent HTTP${status} and gh exit${result.exitCode}`);
    }
    const headerBytes = bytes.subarray(statusLineEnd + 1, separator.index);
    const body = bytes.subarray(separator.index + separator[0].length);
    const headers = new Map<string, string>();
    for (const line of headerBytes.toString('latin1').split(/\r?\n/)) {
      if (!line) continue;
      const colon = line.indexOf(':');
      if (colon < 1) throw new Error('GitHub response: expected complete named HTTP headers');
      const name = line.slice(0, colon).toLowerCase();
      if (
        headers.has(name) &&
        ['content-length', 'content-encoding', 'transfer-encoding'].includes(name)
      ) {
        throw new Error(`GitHub response: duplicate ${name} header`);
      }
      headers.set(name, line.slice(colon + 1).trim());
    }
    const length = headers.get('content-length');
    if (
      length !== undefined &&
      !headers.has('content-encoding') &&
      !headers.has('transfer-encoding')
    ) {
      if (!/^\d+$/.test(length) || Number(length) !== body.byteLength) {
        throw new Error(
          `Incomplete GitHub response: expected ${length} bytes; received ${body.byteLength}`
        );
      }
    }
    return { status, body, headers };
  }

  private requireRepositoryPath(path: string): void {
    if (
      (path !== this.base && !path.startsWith(`${this.base}/`)) ||
      /[\r\n#\\]/.test(path) ||
      path.split(/[/?]/).some((part) => part === '.' || part === '..')
    ) {
      throw new Error(`Invalid GitHub API path: expected path inside ${this.base}`);
    }
  }
}

type ReadAttempt =
  | {
      readonly parsed: GitHubResponse<Uint8Array> & {
        readonly headers: ReadonlyMap<string, string>;
      };
    }
  | { readonly unanswered: unknown; readonly failure: GitHubHttpFailure | GitHubNetworkFailure };

/** `gh api --include` prints `HTTP/<version> <status>` first whenever the server answered. */
function startsWithHttpStatusLine(stdout: Uint8Array): boolean {
  return /^HTTP\/\d/.test(Buffer.from(stdout.subarray(0, 8)).toString('ascii'));
}

function requireOk(status: number, name: string): void {
  if (status !== 200) throw new Error(`GitHub ${name}: expected HTTP200; received HTTP${status}`);
}
