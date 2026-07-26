#!/usr/bin/env bun
// Publish the staged npm distribution idempotently. The release workflow prepares
// dist-npm/ with pack-npm.ts, then this script skips already-published versions,
// retries transient registry failures, and publishes the wrapper last.

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT_DIR } from '../lib/config';
import { MAIN_PACKAGE } from '../lib/npm-pack';
import {
  appendNpmPublishGithubOutputs,
  formatNpmPublishSummary,
  type NpmCommandResult,
  type NpmPublishPackage,
  type NpmRunner,
  orderNpmPackageDirs,
  type ProvenancePolicy,
  parseProvenancePolicy,
  publishPackages,
} from '../lib/npm-publish';
import { error, header, log, success, warn } from '../lib/runner';

interface CliArgs {
  readonly distDir: string;
  readonly dryRun: boolean;
  readonly distTag: string | undefined;
  readonly provenancePolicy: ProvenancePolicy;
}

class RegistryRunner implements NpmRunner {
  async run(args: readonly string[], options: { readonly cwd: string }): Promise<NpmCommandResult> {
    // Reads go through `bun pm view` (clear missing-version signal). Writes use
    // a pinned npm CLI via npx so provenance/trusted-publishing needs (>=11.5.1)
    // are met without an ad-hoc global install in the workflow.
    const cmd =
      args[0] === 'view' ? ['bun', 'pm', ...args] : ['npx', '--yes', 'npm@11.5.1', ...args];
    const proc = Bun.spawn({
      cmd,
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
  console.log(`Usage: bun ./scripts/release/publish-npm.ts [dist-dir] [--dry-run] [--tag <dist-tag>] [--provenance-policy <policy>]

Publishes staged npm packages platform-first, then the ${MAIN_PACKAGE} wrapper.

Arguments:
  dist-dir   Staged npm distribution directory (default: dist-npm)

Flags:
  --dry-run        Check registry state and print publish decisions without publishing
  --tag <dist-tag>  Publish under this npm dist-tag (e.g. canary). Default: latest
  --provenance-policy <policy>
                   required (default), optional, or disabled
  --help           Show this help message`);
  process.exit(0);
};

const parseArgs = (args: readonly string[]): CliArgs => {
  let distArg: string | undefined;
  let dryRun = false;
  let distTag: string | undefined;
  let provenancePolicy: ProvenancePolicy = 'required';

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help') printHelp();
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--tag') {
      const next = args[index + 1];
      if (!next || next.startsWith('-')) throw new Error('--tag requires a dist-tag value');
      distTag = next;
      index += 1;
      continue;
    }
    if (arg.startsWith('--tag=')) {
      distTag = arg.slice('--tag='.length);
      if (!distTag) throw new Error('--tag requires a dist-tag value');
      continue;
    }
    if (arg === '--provenance-policy') {
      const next = args[index + 1];
      if (!next || next.startsWith('-')) {
        throw new Error('--provenance-policy requires required, optional, or disabled');
      }
      provenancePolicy = parseProvenancePolicy(next);
      index += 1;
      continue;
    }
    if (arg.startsWith('--provenance-policy=')) {
      provenancePolicy = parseProvenancePolicy(arg.slice('--provenance-policy='.length));
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    if (distArg) throw new Error(`Unexpected argument: ${arg}`);
    distArg = arg;
  }

  return {
    distDir: resolve(ROOT_DIR, distArg ?? 'dist-npm'),
    dryRun,
    distTag,
    provenancePolicy,
  };
};

const loadPackages = (distDir: string): NpmPublishPackage[] => {
  const dirNames = readdirSync(distDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const packages = orderNpmPackageDirs(dirNames).map((dirName) => readPackage(distDir, dirName));

  if (packages.length === 0) throw new Error(`No npm package directories found in ${distDir}`);
  if (packages.at(-1)?.name !== MAIN_PACKAGE) {
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

const parseAllowLegacyToken = (): boolean => {
  const value = process.env.NPM_PUBLISH_ALLOW_LEGACY_TOKEN;
  return value === 'true' || value === '1';
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const packages = loadPackages(args.distDir);

  const tagLabel = args.distTag ? ` (dist-tag: ${args.distTag})` : '';
  header(`${args.dryRun ? 'Dry-run npm publish' : 'Publish npm packages'}${tagLabel}`);
  const summary = await publishPackages(packages, {
    allowLegacyToken: parseAllowLegacyToken(),
    dryRun: args.dryRun,
    distTag: args.distTag,
    provenancePolicy: args.provenancePolicy,
    logger: { info: log, warn },
    runner: new RegistryRunner(),
  });

  appendNpmPublishGithubOutputs(summary);
  success(formatNpmPublishSummary(summary));
};

if (import.meta.main) {
  try {
    await main();
  } catch (caught) {
    if (process.env.GITHUB_OUTPUT) {
      appendNpmPublishGithubOutputs({
        published: 0,
        skipped: 0,
        dryRun: 0,
        auth: 'failed',
        provenance: { status: 'failed' },
      });
    }
    error(caught instanceof Error ? caught.message : String(caught));
    process.exit(1);
  }
}
