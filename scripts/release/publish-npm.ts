#!/usr/bin/env bun
// Publish the staged npm distribution idempotently. The release workflow prepares
// dist-npm/ with pack-npm.ts, then this script skips already-published versions,
// retries transient registry failures, and publishes the wrapper last.

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT_DIR } from '../lib/config';
import {
  type NpmCommandResult,
  type NpmPublishPackage,
  type NpmRunner,
  orderNpmPackageDirs,
  publishPackages,
} from '../lib/npm-publish';
import { error, header, log, success, warn } from '../lib/runner';

interface CliArgs {
  readonly distDir: string;
  readonly dryRun: boolean;
}

class BunNpmRunner implements NpmRunner {
  async run(args: readonly string[], options: { readonly cwd: string }): Promise<NpmCommandResult> {
    const proc = Bun.spawn({
      cmd: ['npm', ...args],
      cwd: options.cwd,
      stderr: 'pipe',
      stdin: 'ignore',
      stdout: 'pipe',
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  }
}

const printHelp = (): never => {
  console.log(`Usage: bun ./scripts/release/publish-npm.ts [dist-dir] [--dry-run]

Publishes staged npm packages platform-first, then the @mangostudio/cli wrapper.

Arguments:
  dist-dir   Staged npm distribution directory (default: dist-npm)

Flags:
  --dry-run  Check registry state and print publish decisions without publishing
  --help     Show this help message`);
  process.exit(0);
};

const parseArgs = (args: readonly string[]): CliArgs => {
  let distArg: string | undefined;
  let dryRun = false;

  for (const arg of args) {
    if (arg === '--help') printHelp();
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    if (distArg) throw new Error(`Unexpected argument: ${arg}`);
    distArg = arg;
  }

  return { distDir: resolve(ROOT_DIR, distArg ?? 'dist-npm'), dryRun };
};

const loadPackages = (distDir: string): NpmPublishPackage[] => {
  const dirNames = readdirSync(distDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const packages = orderNpmPackageDirs(dirNames).map((dirName) => readPackage(distDir, dirName));

  if (packages.length === 0) throw new Error(`No npm package directories found in ${distDir}`);
  if (packages.at(-1)?.name !== '@mangostudio/cli') {
    throw new Error('Staged npm distribution must include dist-npm/cli as the final package.');
  }

  return packages;
};

const readPackage = (distDir: string, dirName: string): NpmPublishPackage => {
  const dir = join(distDir, dirName);
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    name?: unknown;
    version?: unknown;
  };

  if (typeof manifest.name !== 'string') throw new Error(`Missing package name in ${dirName}`);
  if (typeof manifest.version !== 'string')
    throw new Error(`Missing package version in ${dirName}`);
  return { dir, name: manifest.name, version: manifest.version };
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const packages = loadPackages(args.distDir);

  header(args.dryRun ? 'Dry-run npm publish' : 'Publish npm packages');
  const summary = await publishPackages(packages, {
    dryRun: args.dryRun,
    logger: { info: log, warn },
    runner: new BunNpmRunner(),
  });

  success(
    `npm publish complete: ${summary.published} published, ${summary.skipped} skipped, ${summary.dryRun} dry-run.`
  );
};

if (import.meta.main) {
  try {
    await main();
  } catch (caught) {
    error(caught instanceof Error ? caught.message : String(caught));
    process.exit(1);
  }
}
