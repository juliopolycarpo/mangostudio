#!/usr/bin/env bun
// Publish rendered distribution files (Homebrew formula today, Scoop manifest
// later) into an external repo: clone, copy only changed files, commit as
// github-actions[bot], and push with a rebase retry. Re-runs are no-ops.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { captureCommand } from '../lib/exec';
import { error, success } from '../lib/log';

const GIT_BOT_NAME = 'github-actions[bot]';
const GIT_BOT_EMAIL = 'github-actions[bot]@users.noreply.github.com';
const PUSH_ATTEMPTS = 3;

export interface FileMapping {
  readonly localPath: string;
  readonly repoPath: string;
}

export interface PushDistRepoArgs {
  readonly repo: string;
  readonly tokenEnv: string;
  readonly message: string;
  readonly branch?: string;
  readonly mappings: readonly FileMapping[];
}

/** Parse `<local>:<repo-path>` mappings, rejecting paths that could escape the clone. */
export function parseFileMappings(specs: readonly string[]): FileMapping[] {
  if (specs.length === 0) {
    throw new Error('At least one --file <local>:<repo-path> mapping is required');
  }

  return specs.map((spec) => {
    const separator = spec.indexOf(':');
    if (separator <= 0 || separator === spec.length - 1) {
      throw new Error(`Invalid --file mapping "${spec}". Expected <local>:<repo-path>.`);
    }

    const localPath = spec.slice(0, separator);
    const repoPath = spec.slice(separator + 1);
    if (repoPath.startsWith('/') || repoPath.split('/').includes('..')) {
      throw new Error(`Unsafe repo path in --file mapping "${spec}".`);
    }
    return { localPath, repoPath };
  });
}

/** Parse the CLI arguments for this script. // Usage: parsePushDistRepoArgs(process.argv.slice(2)) */
export function parsePushDistRepoArgs(argv: readonly string[]): PushDistRepoArgs {
  const values: Record<string, string> = {};
  const fileSpecs: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--repo', '--token-env', '--message', '--branch', '--file'].includes(flag)) {
      throw new Error(`Unknown argument: ${flag}`);
    }
    if (value === undefined) {
      throw new Error(`Missing value for ${flag}`);
    }
    if (flag === '--file') fileSpecs.push(value);
    else values[flag] = value;
    index += 1;
  }

  const repo = values['--repo'];
  const tokenEnv = values['--token-env'];
  const message = values['--message'];
  if (!repo || !tokenEnv || !message) {
    throw new Error('--repo, --token-env, and --message are required');
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error(`Invalid --repo "${repo}". Expected <owner>/<name>.`);
  }

  return {
    repo,
    tokenEnv,
    message,
    branch: values['--branch'],
    mappings: parseFileMappings(fileSpecs),
  };
}

/** Copy mapped files into the clone, returning the repo paths whose content changed. */
export function syncFilesIntoClone(mappings: readonly FileMapping[], cloneDir: string): string[] {
  const changed: string[] = [];
  for (const { localPath, repoPath } of mappings) {
    const next = readFileSync(localPath);
    const destination = join(cloneDir, repoPath);
    // Read the destination once and treat a missing file as "changed", instead of
    // an existsSync probe that another process could invalidate before the read.
    const current = readFileIfPresent(destination);
    if (current?.equals(next)) continue;
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, next);
    changed.push(repoPath);
  }
  return changed;
}

function readFileIfPresent(filePath: string): Buffer | null {
  try {
    return readFileSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export interface PushDistRepoOptions {
  readonly remoteUrl: string;
  readonly message: string;
  readonly mappings: readonly FileMapping[];
  /** `AUTHORIZATION: basic <b64>` header for github.com; omit for local remotes. */
  readonly authHeader?: string;
  readonly branch?: string;
}

/**
 * Clone the dist repo, sync the mapped files, and push an idempotent commit.
 * Returns 'up-to-date' without committing when nothing changed.
 * // Usage: await pushDistRepo({ remoteUrl, message, mappings })
 */
export async function pushDistRepo(options: PushDistRepoOptions): Promise<'pushed' | 'up-to-date'> {
  const workDir = mkdtempSync(join(tmpdir(), 'mangostudio-dist-repo-'));
  const cloneDir = join(workDir, 'clone');
  const git = createGitRunner(options.authHeader);

  try {
    const branchArgs = options.branch ? ['--branch', options.branch] : [];
    await git(['clone', '--quiet', ...branchArgs, options.remoteUrl, cloneDir]);

    const changed = syncFilesIntoClone(options.mappings, cloneDir);
    if (changed.length === 0) return 'up-to-date';

    await git(['-C', cloneDir, 'config', 'user.name', GIT_BOT_NAME]);
    await git(['-C', cloneDir, 'config', 'user.email', GIT_BOT_EMAIL]);
    // The ephemeral CI clone has no signing key; never inherit a host policy.
    await git(['-C', cloneDir, 'config', 'commit.gpgsign', 'false']);
    await git(['-C', cloneDir, 'add', '--', ...changed]);
    await git(['-C', cloneDir, 'commit', '--quiet', '-m', options.message]);

    for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt += 1) {
      try {
        await git(['-C', cloneDir, 'push', '--quiet', 'origin', 'HEAD']);
        return 'pushed';
      } catch (caught) {
        if (attempt === PUSH_ATTEMPTS) throw caught;
        await git(['-C', cloneDir, 'pull', '--rebase', '--quiet']);
      }
    }
    throw new Error('unreachable');
  } finally {
    rmSync(workDir, { force: true, recursive: true });
  }
}

type GitRunner = (args: string[]) => Promise<void>;

// Credentials travel as a per-invocation http.extraheader (the actions/checkout
// pattern), so the remote URL — and therefore every git error message — stays
// token-free. The header value is still scrubbed from output defensively.
function createGitRunner(authHeader?: string): GitRunner {
  const configArgs = authHeader ? ['-c', `http.https://github.com/.extraheader=${authHeader}`] : [];

  return async (args: string[]): Promise<void> => {
    const { stdout, stderr, exitCode } = await captureCommand(['git', ...configArgs, ...args]);
    if (exitCode === 0) return;

    let output = stderr.trim() || stdout.trim();
    if (authHeader) output = output.replaceAll(authHeader, '***');
    throw new Error(`git ${args.join(' ')} failed (${exitCode}): ${output}`);
  };
}

/** Build the basic-auth header GitHub expects for installation/PAT tokens. */
export function buildGitHubAuthHeader(token: string): string {
  const credentials = Buffer.from(`x-access-token:${token}`).toString('base64');
  return `AUTHORIZATION: basic ${credentials}`;
}

const printHelp = (): never => {
  console.log(`Usage: bun ./scripts/release/push-dist-repo.ts --repo <owner/name> --token-env <ENV> --message <msg> --file <local>:<repo-path> [--file ...] [--branch <name>]

Pushes rendered distribution files into an external repo (Homebrew tap, Scoop
bucket). Only the mapped files are touched; unchanged content exits 0 without
committing, and rejected pushes are rebased and retried.`);
  process.exit(0);
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.length === 0) printHelp();

  const args = parsePushDistRepoArgs(argv);
  const token = (process.env[args.tokenEnv] ?? '').trim();
  if (token.length === 0) {
    throw new Error(`Environment variable ${args.tokenEnv} is empty or unset`);
  }

  const result = await pushDistRepo({
    remoteUrl: `https://github.com/${args.repo}.git`,
    authHeader: buildGitHubAuthHeader(token),
    branch: args.branch,
    message: args.message,
    mappings: args.mappings,
  });

  if (result === 'up-to-date') success(`${args.repo} already up to date`);
  else success(`Pushed "${args.message}" to ${args.repo}`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (caught) {
    error(caught instanceof Error ? caught.message : String(caught));
    process.exit(1);
  }
}
