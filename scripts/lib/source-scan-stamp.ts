// Pass stamps for the seven source scans `bun run check` runs: the four import
// cycle scans (`frontend:cycles`, `api:cycles`, `shared:cycles`, `root:cycles`),
// `root:node-env-branches`, `frontend:api-import-boundary` and
// `root:shared-import-boundary`. Each is a pure function of the repository's
// JS, TS and JSON files, its symlinks and its installed workspace links. On an
// edit that touches none of them it gives the answer it gave last time, and
// costs seconds of parsing to do so.
//
// One key serves all seven. A key per workspace would be unsafe: the cycle scan
// follows imports through tsconfig paths and the `node_modules` workspace links
// into other workspaces, so any file can change another scan's verdict. The key
// reruns the scans on any source edit.
//
// Inputs the key covers:
//   - Every file Git lists (tracked, or untracked and not ignored) with a JS, TS,
//     JSON or JSONC extension: each file `shared-import-boundary` reads, each
//     tsconfig and `package.json` the compiler's resolution reads, and the
//     scripts that implement the scans.
//   - Every file on disk with such an extension, minus what the cycle scan skips
//     (`isCycleScanExcluded`). That adds gitignored generated source, and covers
//     every file an import can resolve to: the scan follows an import only to a
//     local file it does not skip.
//   - The paths `node-env-branches` and `frontend-api-import-boundary` enumerate,
//     taken from the functions those scans call, because their globs skip fewer
//     directories than the cycle scan does.
//   - `bun.lock`, `.bun-version` and `bunfig.toml`. Third-party `node_modules`
//     content is covered by the lockfile and the Bun version, as in the protocol
//     stamp.
//   - The `node_modules` links into workspaces, in the root and in every
//     workspace: a reinstall that relinks one changes resolution while `bun.lock`
//     keeps its bytes.
//   - Every symlink the cycle scan's walk meets, and every symlink Git lists, as
//     `path -> readlink target`. The scan follows imports through a link to files
//     the key hashes under their real paths, so retargeting a link changes the
//     verdict while no hashed byte moves.
//   - The list of Git-listed source paths. The key's file set is Git plus disk,
//     and `shared-import-boundary` reads only the Git part, so a file moving
//     between ignored and listed has to move the key.
//   - The command, the Bun build and the host. No scan reads an environment
//     variable.
//
// A key that cannot be computed (an unreadable directory, a failing `git
// ls-files`) is a cache miss: the scan runs, the reason is reported once, and no
// stamp is written. It never fails the check.
//
// Not covered: files outside the repository (a `node_modules` or `package.json`
// above the checkout root, `~/.bunfig.toml`). An import that resolves there is
// not local, and the scans drop it.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { RunResult } from './exec';
import { listCheckoutFiles } from './git';
import { dim } from './log';
import { PASS_STAMP_DIR, passStampKey, runWithPassStamp } from './pass-stamp';
import {
  listCycleScanTreeFiles,
  listCycleScanTreeSymlinks,
  listFrontendBoundaryPaths,
  listNodeEnvScanPaths,
  listSymlinksAmong,
  readSymlinkTarget,
} from './source-scan-paths';

/** Extensions a source scan reads, or the compiler's resolution reads for it. Case-insensitive, like the cycle scan's own test. */
const SOURCE_SCAN_INPUT_EXTENSION = /\.(?:[cm]?[jt]s|[jt]sx|jsonc?)$/i;

/** Files outside that extension list that decide what the scans run on. */
const SOURCE_SCAN_HOST_FILES = ['bun.lock', '.bun-version', 'bunfig.toml'] as const;

/**
 * Every file the seven source scans' results depend on, repository-relative.
 *
 * @example
 * sourceScanInputFiles('/repo', ['apps/api/src/app.ts', 'docs/a.md']); // ['apps/api/src/app.ts', ...]
 */
export function sourceScanInputFiles(
  rootDir: string,
  checkoutFiles: readonly string[] = listCheckoutFiles(rootDir)
): string[] {
  const hostFiles = new Set<string>(SOURCE_SCAN_HOST_FILES);
  const fromGit = checkoutFiles.filter(
    (file) => SOURCE_SCAN_INPUT_EXTENSION.test(file) || hostFiles.has(file)
  );
  // The stamps are JSON the scans never read. Where `.mango` is not gitignored
  // they would otherwise be keyed, and writing one would change the key.
  const stampPrefix = `${PASS_STAMP_DIR}/`;
  return [
    ...new Set([
      ...fromGit,
      ...listCycleScanTreeFiles(rootDir, SOURCE_SCAN_INPUT_EXTENSION),
      ...listNodeEnvScanPaths(rootDir),
      ...listFrontendBoundaryPaths(rootDir),
    ]),
  ]
    .filter((file) => !file.startsWith(stampPrefix))
    .sort();
}

/** The names in a directory; none when it is missing or is not a directory. */
function listDirectory(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch (caught) {
    const code = (caught as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw caught;
  }
}

/**
 * The directories whose `node_modules` the scans' resolution can start from: the
 * repository root and each workspace named by the root `package.json`
 * (`dir/*` patterns and plain directories).
 */
function workspaceDirectories(rootDir: string): string[] {
  const directories = [''];
  let patterns: unknown;
  try {
    const manifest = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')) as {
      workspaces?: unknown;
    };
    patterns = manifest.workspaces;
  } catch {
    // No readable manifest: the root links are all there is to record.
    return directories;
  }
  for (const pattern of Array.isArray(patterns) ? patterns : []) {
    if (typeof pattern !== 'string') continue;
    if (!pattern.endsWith('/*')) {
      directories.push(pattern);
      continue;
    }
    const parent = pattern.slice(0, -2);
    for (const name of listDirectory(join(rootDir, parent))) directories.push(`${parent}/${name}`);
  }
  return directories;
}

/**
 * The installed `node_modules` links that point at workspaces, as
 * `path -> target` lines, from the root and from every workspace: with Bun's
 * isolated layout an import in `apps/api` resolves `@mangostudio/shared`
 * through `apps/api/node_modules` first. Links into Bun's package store and
 * `.bin` are third-party content, which the lockfile covers, and are left out.
 *
 * @example
 * workspaceLinks('/repo');
 * // ['apps/api/node_modules/@mangostudio/shared -> ../../../shared', ...]
 */
export function workspaceLinks(rootDir: string): string[] {
  const links: string[] = [];
  const record = (display: string, path: string): void => {
    const target = readSymlinkTarget(path);
    if (target !== null && !target.split('/').includes('.bun')) {
      links.push(`${display} -> ${target}`);
    }
  };
  for (const workspace of workspaceDirectories(rootDir)) {
    const modules = join(rootDir, workspace, 'node_modules');
    const shown = workspace === '' ? 'node_modules' : `${workspace}/node_modules`;
    for (const name of listDirectory(modules)) {
      if (name === '.bin' || name === '.bun') continue;
      if (name.startsWith('@')) {
        for (const member of listDirectory(join(modules, name))) {
          record(`${shown}/${name}/${member}`, join(modules, name, member));
        }
      } else record(`${shown}/${name}`, join(modules, name));
    }
  }
  return links.sort();
}

/** The extension test the shared root import scan applies to Git-listed paths. */
const SHARED_ROOT_SCAN_EXTENSION = /\.(?:[cm]?[jt]s|[jt]sx)$/;

/**
 * Everything but file bytes that the scans' results depend on: the Bun build,
 * the host, the workspace links, which source paths Git lists, and the symlinks
 * the scans can follow.
 *
 * The listing is a fact because the key's file set unions Git and disk:
 * `shared-import-boundary` reads exactly the Git-listed sources, so a file that
 * moves between ignored and listed (a `.gitignore` edit, `git add -f`) changes
 * that scan's verdict with no byte of it changing.
 *
 * @example
 * sourceScanFacts('/repo', ['apps/api/src/app.ts']).host; // 'linux x64'
 */
export function sourceScanFacts(
  rootDir: string,
  checkoutFiles: readonly string[] = listCheckoutFiles(rootDir)
): Record<string, string> {
  return {
    bun: `${Bun.version} ${Bun.revision}`,
    host: `${process.platform} ${process.arch}`,
    workspaceLinks: JSON.stringify(workspaceLinks(rootDir)),
    listedSources: JSON.stringify(
      checkoutFiles.filter((file) => SHARED_ROOT_SCAN_EXTENSION.test(file)).sort()
    ),
    symlinks: JSON.stringify(
      [
        ...new Set([
          ...listCycleScanTreeSymlinks(rootDir),
          ...listSymlinksAmong(rootDir, checkoutFiles),
        ]),
      ].sort()
    ),
  };
}

/**
 * The digest of every input the seven scans share, taken now.
 *
 * @example
 * sourceScanInputDigest('/repo'); // 'ab12…' (64 hex)
 */
export function sourceScanInputDigest(rootDir: string): string {
  const checkoutFiles = listCheckoutFiles(rootDir);
  return passStampKey(rootDir, {
    files: sourceScanInputFiles(rootDir, checkoutFiles),
    facts: sourceScanFacts(rootDir, checkoutFiles),
  });
}

/**
 * One task's pass-stamp key: the shared input digest and the command, so a
 * scan whose roots changed in `check.ts` misses even where its files did not.
 *
 * @example
 * sourceScanTaskKey('/repo', digest, ['bun', 'scripts/check-import-cycles.ts', 'apps/api']);
 */
export function sourceScanTaskKey(
  rootDir: string,
  inputDigest: string,
  command: readonly string[]
): string {
  return passStampKey(rootDir, {
    files: [],
    facts: { inputs: inputDigest, command: JSON.stringify(command) },
  });
}

export interface SourceScanStamperOptions {
  readonly rootDir: string;
  readonly stampDir: string;
  /** False runs every scan and neither reads nor writes a stamp. */
  readonly enabled: boolean;
  /** The shared input digest; replaceable so a test can count and order its calls. */
  readonly inputDigest?: (rootDir: string) => string;
  /** Where replay and miss lines go; `runWithPassStamp`'s default when omitted. */
  readonly report?: (message: string) => void;
}

export type SourceScanStamper = (
  label: string,
  command: readonly string[],
  run: () => Promise<RunResult>
) => () => Promise<RunResult>;

/** The input digest could not be taken; the scan runs without a stamp. */
class ScanKeyUnavailable extends Error {}

/**
 * Wrap scans in pass stamps that share one input digest.
 *
 * Every key request waits one macrotask, then the digest is computed once for
 * all of them. At the start of a check that is the "before" digest shared by
 * every scan, taken after the runner has spawned its other tasks, because the
 * digest is a synchronous pass over thousands of files. After a scan, the
 * request is its "after" digest, computed once the scan has ended; requests
 * from scans that end while another digest is being computed batch into the
 * next one. A digest is always taken after the request that receives it, so it
 * is never older than the run it vouches for.
 *
 * A digest that throws is a miss, not a failure: the scan runs (or, when only
 * the "after" digest failed, keeps the result it already has), no stamp is
 * written, and the reason is reported once per stamper.
 *
 * @example
 * const stamp = createSourceScanStamper({ rootDir, stampDir, enabled: true });
 * const run = stamp('root:cycles', command, () => runCommand('root:cycles', command));
 */
export function createSourceScanStamper(options: SourceScanStamperOptions): SourceScanStamper {
  const digest = options.inputDigest ?? sourceScanInputDigest;
  const report = options.report ?? dim;
  let reported = false;
  let waiting: Array<{
    resolve: (value: string) => void;
    reject: (reason: unknown) => void;
  }> = [];
  const nextDigest = (): Promise<string> =>
    new Promise((resolve, reject) => {
      waiting.push({ resolve, reject });
      if (waiting.length > 1) return;
      setTimeout(() => {
        const batch = waiting;
        waiting = [];
        try {
          const taken = digest(options.rootDir);
          for (const waiter of batch) waiter.resolve(taken);
        } catch (caught) {
          const reason = new ScanKeyUnavailable(
            caught instanceof Error ? caught.message : String(caught),
            { cause: caught }
          );
          for (const waiter of batch) waiter.reject(reason);
        }
      }, 0);
    });

  return (label, command, run) => async () => {
    let finished: RunResult | undefined;
    try {
      return await runWithPassStamp({
        label,
        stampDir: options.stampDir,
        enabled: options.enabled,
        key: async () => sourceScanTaskKey(options.rootDir, await nextDigest(), command),
        run: async () => (finished = await run()),
        report,
      });
    } catch (caught) {
      if (!(caught instanceof ScanKeyUnavailable)) throw caught;
      if (!reported) {
        reported = true;
        report(
          `  source scans run without pass stamps: expected the scan inputs to be readable | received: ${caught.message}`
        );
      }
      // Only an exit-0 run reaches the "after" digest, and its result is the one to keep.
      return finished ?? run();
    }
  };
}
