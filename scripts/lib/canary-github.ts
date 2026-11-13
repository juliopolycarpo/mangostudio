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
const READ_ATTEMPTS = 3;
const READ_BACKOFF_MS = 5_000;
// Server errors, rate limiting and dropped connections; 4xx auth/not-found stay fatal.
const TRANSIENT_STDERR =
  /HTTP (?:5\d\d|429)\b|\b(?:timeout|timed out|EOF|connection reset|connection refused|temporar(?:y|ily)|unexpected end)\b/i;

/** Whether gh stderr describes a failure worth rereading. Example: isTransientGhFailure('gh: Bad Gateway (HTTP 502)'). */
export function isTransientGhFailure(stderr: string): boolean {
  return TRANSIENT_STDERR.test(stderr);
}

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

  constructor(
    repository: string,
    private readonly runner: GhCommandRunner = ghRunner,
    private readonly sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
      Bun.sleep(milliseconds)
  ) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
      throw new Error(`Invalid GitHub repository: ${repository}; expected owner/repository`);
    }
    this.base = `repos/${repository}`;
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
      const release = object(entry, 'release listing entry');
      positiveId(release.id, 'release listing ID');
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
    let current = object(response.body, 'tag reference').object;
    const seen = new Set<string>();
    for (let depth = 0; depth < 8; depth += 1) {
      const target = object(current, 'tag target');
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
      current = object(annotation.body, 'annotated tag').object;
    }
    throw new Error('Annotated tag depth exceeds8; expected bounded tag chain ending in commit');
  }

  /** Read every asset page before deciding release completeness. Example: await client.listAssets(123). */
  async listAssets(releaseId: number): Promise<readonly unknown[]> {
    positiveId(releaseId, 'release ID');
    return this.list(`${this.base}/releases/${releaseId}/assets?per_page=100`);
  }

  /** Read repository JSON with actual status; callers must reject non200/non404 responses. Example: await client.getJson('repos/owner/repo/actions/runs/123'). */
  async getJson(path: string): Promise<GitHubResponse<unknown>> {
    const response = await Promise.resolve(this.read(path));
    let body: unknown;
    try {
      body = JSON.parse(Buffer.from(response.body).toString('utf8'));
    } catch {
      throw new Error(`GitHub JSON response: expected valid JSON for HTTP${response.status}`);
    }
    return { status: response.status, body };
  }

  /** Read binary repository evidence while retaining actual HTTP status. Example: await client.readBytes('repos/owner/repo/actions/artifacts/123/zip'). */
  async readBytes(path: string, accept?: string): Promise<GitHubResponse<Uint8Array>> {
    return await Promise.resolve(this.read(path, accept));
  }

  /** Download a small release evidence asset without rendering bytes or credentials. Example: await client.readAsset(456). */
  async readAsset(assetId: number): Promise<GitHubResponse<Uint8Array>> {
    positiveId(assetId, 'asset ID');
    return await Promise.resolve(
      this.read(`${this.base}/releases/assets/${assetId}`, 'application/octet-stream')
    );
  }

  /** Read paginated array responses, or counted object collections. Example: await client.list('repos/owner/repo/releases?per_page=100'). */
  async list(path: string, key?: string): Promise<readonly unknown[]> {
    this.requireRepositoryPath(path);
    // A paginated read restarts from page one: a late 5xx must not discard earlier pages for good.
    let result = await Promise.resolve(this.runner.run(['api', '--paginate', '--slurp', path]));
    for (
      let attempt = 1;
      attempt < READ_ATTEMPTS && result.exitCode !== 0 && isTransientGhFailure(result.stderr);
      attempt++
    ) {
      await this.sleep(READ_BACKOFF_MS * attempt);
      result = await Promise.resolve(this.runner.run(['api', '--paginate', '--slurp', path]));
    }
    if (result.exitCode !== 0) {
      throw new Error(
        `GitHub paginated read: expected successful gh exit | received: exit ${result.exitCode} for ${path} | stderr: ${describeGhStderr(result.stderr)}`
      );
    }
    let pages: unknown;
    try {
      pages = JSON.parse(Buffer.from(result.stdout).toString('utf8'));
    } catch {
      throw new Error('GitHub paginated read: expected JSON page collection');
    }
    if (!Array.isArray(pages) || pages.length === 0) {
      throw new Error('GitHub paginated read: expected nonempty array of pages');
    }
    let total: number | undefined;
    const entries: unknown[] = [];
    for (const page of pages) {
      let values: unknown;
      if (key === undefined) {
        values = page;
      } else {
        const collection = object(page, 'GitHub page');
        if (!Number.isSafeInteger(collection.total_count) || Number(collection.total_count) < 0) {
          throw new Error(
            `GitHub page total_count: expected nonnegative safe integer; received ${String(collection.total_count)}`
          );
        }
        if (total !== undefined && total !== collection.total_count) {
          throw new Error(
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
      throw new Error(
        `Incomplete GitHub pages: expected ${total} entries; received ${entries.length}`
      );
    }
    const seen = new Set<number>();
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || !('id' in entry)) continue;
      positiveId(entry.id, 'paginated entry ID');
      if (seen.has(Number(entry.id)))
        throw new Error(`Duplicate GitHub paginated entry ID: ${String(entry.id)}`);
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
      throw new Error(`GitHub command failed: expected exit0; received ${result.exitCode}`);
    }
    return result;
  }

  private read(path: string, accept?: string): GitHubResponse<Uint8Array> {
    this.requireRepositoryPath(path);
    const result = this.runner.run([
      'api',
      '--include',
      ...(accept ? ['--header', `Accept: ${accept}`] : []),
      path,
    ]);
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
    return { status, body };
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

function requireOk(status: number, name: string): void {
  if (status !== 200) throw new Error(`GitHub ${name}: expected HTTP200; received HTTP${status}`);
}
function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`GitHub ${name}: expected object`);
  }
  return value as Record<string, unknown>;
}
function positiveId(value: unknown, name: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Invalid ${name}: expected positive safe integer; received ${String(value)}`);
  }
}
