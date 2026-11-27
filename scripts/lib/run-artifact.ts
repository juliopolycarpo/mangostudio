import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { distributionBundleMember } from './distribution-artifact';
import { ARTIFACT_DOWNLOAD_RETRY_POLICY, GitHubRetry, malformedResponse } from './github-retry';
import { openZipArchive, type ZipArchiveDependencies } from './zip-archive';

// actions/download-artifact has stayed alive for its whole step deadline after
// logging success (#1735). Fetching through the GitHub CLI puts every network
// call under a bound this process owns, on every runner OS, and keeps the
// digest check that the action performed.

/** Longest a metadata request may run before the attempt is abandoned. */
export const METADATA_TIMEOUT_MS = 15_000;
/** Longest an artifact ZIP transfer may run before the attempt is abandoned. */
export const ARCHIVE_TIMEOUT_MS = 70_000;
/**
 * One try plus one retry, 2 s apart (the policy's whole wait). The two attempts
 * and the pause take at most 2 * (15 + 70) + 2 = 172 s, inside the 3-minute step
 * deadline most callers declare.
 */
export const DOWNLOAD_ATTEMPTS = ARTIFACT_DOWNLOAD_RETRY_POLICY.backoffMs.length + 1;

const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;

export interface RunArtifactListing {
  readonly artifacts?: readonly {
    readonly id: number;
    readonly name: string;
    readonly digest: string | null;
    readonly expired: boolean;
    readonly workflow_run?: { readonly id: number };
  }[];
}

export interface RunArtifact {
  readonly id: number;
  readonly digest: string;
}

/**
 * Pick the one live artifact of a run by name, with the digest the API recorded
 * at upload. A missing, duplicated, expired or digest-less artifact is an error.
 * // Usage: selectRunArtifact(listing, 'hub-inputs-abc', 42)
 */
export function selectRunArtifact(
  listing: RunArtifactListing,
  name: string,
  runId: number
): RunArtifact {
  const matches = (listing.artifacts ?? []).filter((artifact) => artifact.name === name);
  const [artifact] = matches;
  if (matches.length !== 1 || !artifact) {
    throw new Error(
      `Run ${runId} artifact ${JSON.stringify(name)}: expected exactly one | received ${matches.length}`
    );
  }
  if (artifact.expired) {
    throw new Error(
      `Run ${runId} artifact ${JSON.stringify(name)}: expected unexpired | received expired`
    );
  }
  if (artifact.workflow_run?.id !== runId) {
    throw new Error(
      `Run ${runId} artifact ${JSON.stringify(name)} workflow run: expected ${runId} | received ${artifact.workflow_run?.id}`
    );
  }
  if (!artifact.digest || !SHA256_DIGEST.test(artifact.digest)) {
    throw new Error(
      `Run ${runId} artifact ${JSON.stringify(name)} digest: expected sha256:<64 lowercase hex> | received ${artifact.digest}`
    );
  }
  return { id: artifact.id, digest: artifact.digest };
}

/**
 * Refuse ZIP entries that could land outside the destination: absolute paths,
 * drive letters, backslashes and `..` segments.
 * // Usage: assertSafeZipEntries(['a/b.txt'])
 */
export function assertSafeZipEntries(entries: readonly string[]): void {
  for (const entry of entries) {
    const unsafe =
      entry === '' ||
      entry.startsWith('/') ||
      /^[a-zA-Z]:/.test(entry) ||
      entry.includes('\\') ||
      entry.split('/').includes('..');
    if (unsafe) {
      throw new Error(
        `Artifact ZIP entry: expected a relative path inside the archive | received ${JSON.stringify(entry)}`
      );
    }
  }
}

interface BoundedCommandResult {
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly stdout: string;
}

/** Runs one command and kills it after `timeoutMs`. Injected so tests need no real process. */
export type BoundedRunner = (
  command: readonly string[],
  options: { readonly timeoutMs: number; readonly stdoutFile?: string }
) => Promise<BoundedCommandResult>;

/**
 * Run a command, killing it after `timeoutMs`. Stdout is captured, or written to
 * `stdoutFile` for a large transfer. This owns the bound itself rather than
 * relying on `timeout`, which Windows runners resolve to a different program.
 * // Usage: await runBounded(['gh', 'api', 'rate_limit'], { timeoutMs: 15_000 })
 */
export const runBounded: BoundedRunner = async (command, options) => {
  let timedOut = false;
  const killAfterBound = (proc: { kill: () => void }): ReturnType<typeof setTimeout> =>
    setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, options.timeoutMs);

  if (options.stdoutFile) {
    const proc = Bun.spawn([...command], {
      stdout: Bun.file(options.stdoutFile),
      stderr: 'inherit',
    });
    const timer = killAfterBound(proc);
    try {
      return { exitCode: await proc.exited, timedOut, stdout: '' };
    } finally {
      clearTimeout(timer);
    }
  }
  const proc = Bun.spawn([...command], { stdout: 'pipe', stderr: 'inherit' });
  const timer = killAfterBound(proc);
  try {
    const stdout = await new Response(proc.stdout).text();
    return { exitCode: await proc.exited, timedOut, stdout };
  } finally {
    clearTimeout(timer);
  }
};

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

/**
 * Download an artifact ZIP under a bound and reject bytes whose sha256 differs
 * from `digest`, so a truncated or substituted transfer never reaches extraction.
 * // Usage: await fetchArtifactZip({ repository, artifactId, digest, archive })
 */
export async function fetchArtifactZip(options: {
  readonly repository: string;
  readonly artifactId: number;
  readonly digest: string;
  readonly archive: string;
  readonly run?: BoundedRunner;
  readonly timeoutMs?: number;
  readonly digestOf?: (path: string) => Promise<string>;
}): Promise<void> {
  const run = options.run ?? runBounded;
  const timeoutMs = options.timeoutMs ?? ARCHIVE_TIMEOUT_MS;
  const result = await run(
    ['gh', 'api', `repos/${options.repository}/actions/artifacts/${options.artifactId}/zip`],
    { timeoutMs, stdoutFile: options.archive }
  );
  if (result.timedOut) {
    throw new Error(`Artifact ${options.artifactId}: download timed out after ${timeoutMs} ms`);
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `Artifact ${options.artifactId}: download failed with exit code ${result.exitCode}`
    );
  }
  const actual = await (options.digestOf ?? sha256File)(options.archive);
  if (actual !== options.digest) {
    throw new Error(
      `Artifact ${options.artifactId} ZIP digest: expected ${options.digest} | received ${actual}`
    );
  }
}

/**
 * List a run's artifact by name through the GitHub CLI under the metadata bound.
 * // Usage: const { id, digest } = await findRunArtifact({ repository, runId, name })
 */
export async function findRunArtifact(options: {
  readonly repository: string;
  readonly runId: number;
  readonly name: string;
  readonly run?: BoundedRunner;
}): Promise<RunArtifact> {
  const result = await (options.run ?? runBounded)(
    [
      'gh',
      'api',
      '--method',
      'GET',
      `repos/${options.repository}/actions/runs/${options.runId}/artifacts`,
      '-f',
      `name=${options.name}`,
      '-f',
      'per_page=100',
    ],
    { timeoutMs: METADATA_TIMEOUT_MS }
  );
  if (result.timedOut) {
    throw new Error(
      `Run ${options.runId} artifact list: timed out after ${METADATA_TIMEOUT_MS} ms`
    );
  }
  if (result.exitCode !== 0) {
    throw new Error(`Run ${options.runId} artifact list: gh exited with ${result.exitCode}`);
  }
  const site = { request: `GET runs/${options.runId}/artifacts` };
  let listing: unknown;
  try {
    listing = JSON.parse(result.stdout);
  } catch {
    throw malformedResponse(site, 'an artifact listing object as JSON', result.stdout);
  }
  // A body without the array is not "zero artifacts": name what arrived.
  if (
    typeof listing !== 'object' ||
    listing === null ||
    !Array.isArray((listing as { artifacts?: unknown }).artifacts)
  ) {
    throw malformedResponse(site, 'an object with an "artifacts" array', listing);
  }
  return selectRunArtifact(listing as RunArtifactListing, options.name, options.runId);
}

export interface DownloadRunArtifactOptions {
  readonly repository: string;
  readonly runId: number;
  readonly name: string;
  /** Destination directory; created when missing. */
  readonly destination: string;
  /** `bundle` keeps the one flat distribution tar; `tree` extracts every entry. */
  readonly mode: 'bundle' | 'tree';
  readonly scratchRoot?: string;
  /** Retry runtime for the download attempts; tests pass one that does not sleep. */
  readonly retry?: GitHubRetry;
  readonly run?: BoundedRunner;
  readonly digestOf?: (path: string) => Promise<string>;
  readonly zip?: ZipArchiveDependencies;
  readonly log?: (message: string) => void;
}

/**
 * Download one artifact of the current run through the GitHub CLI and extract it.
 * Every network call is bounded and the whole fetch is tried twice, 2 s apart; the ZIP digest
 * is checked against the one recorded at upload before anything is extracted.
 * // Usage: await downloadRunArtifact({ repository, runId, name, destination, mode: 'tree' })
 */
export async function downloadRunArtifact(options: DownloadRunArtifactOptions): Promise<void> {
  const scratch = mkdtempSync(join(options.scratchRoot ?? tmpdir(), 'run-artifact-'));
  try {
    const archive = join(scratch, 'artifact.zip');
    const retry = options.retry ?? new GitHubRetry(ARTIFACT_DOWNLOAD_RETRY_POLICY);
    await retry.anyFailure(
      `Artifact ${options.name}`,
      async () => {
        const { id, digest } = await findRunArtifact(options);
        await fetchArtifactZip({
          repository: options.repository,
          artifactId: id,
          digest,
          archive,
          run: options.run,
          digestOf: options.digestOf,
        });
      },
      options.log
    );
    const reader = await openZipArchive(archive, options.zip);
    assertSafeZipEntries(reader.entries);
    // Bundle mode names its single member before extracting anything.
    const member =
      options.mode === 'bundle' ? distributionBundleMember(reader.entries.join('\n')) : undefined;
    const staging = join(scratch, 'extract');
    mkdirSync(staging);
    await reader.extract(staging);
    // Bun on Windows throws EEXIST for a recursive mkdir of an existing directory
    // such as `.`, so create the destination only when it is missing.
    if (!existsSync(options.destination)) mkdirSync(options.destination, { recursive: true });
    // Copy over the destination instead of extracting into it: unzip skips files
    // that already exist when it cannot prompt, which would leave stale bytes.
    if (member) copyFileSync(join(staging, member), join(options.destination, member));
    else cpSync(staging, options.destination, { recursive: true, force: true });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
