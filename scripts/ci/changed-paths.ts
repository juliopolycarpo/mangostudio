#!/usr/bin/env bun
// Dependency-free: changes jobs use this before bun install.
// collect <base-sha> <head-sha> <file> keeps both rename sides and writes only
// a successful, nonempty NUL diff. distribution/release <file> emit outputs.
import { writeFileSync } from 'node:fs';
import { decodeChangedPaths, readChangedPaths } from '../lib/changed-paths';
import { distributionRelevant, releaseRelevance } from '../lib/ci-lanes';

/**
 * Collect literal paths without shell interpolation or Git's quoting rules.
 * @example
 * writeFileSync('changed.nul', collectChangedPaths(baseSha, headSha));
 */
export function collectChangedPaths(base: string, head: string): Uint8Array {
  if (![base, head].every((sha) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha))) {
    throw new Error(
      `changed-paths collect: received base=${JSON.stringify(base)}, head=${JSON.stringify(head)}; expected 40- or 64-character lowercase hex commit SHAs`
    );
  }
  const diff = Bun.spawnSync(
    ['git', 'diff', '--no-renames', '--name-only', '-z', base, head, '--'],
    {
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  if (diff.exitCode !== 0) {
    throw new Error(
      `changed-paths: git diff failed (${diff.exitCode}): ${diff.stderr.toString().trim()}`
    );
  }
  decodeChangedPaths(diff.stdout);
  return diff.stdout;
}

if (import.meta.main) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'collect' && args.length === 3) {
      writeFileSync(args[2] as string, collectChangedPaths(args[0] as string, args[1] as string));
    } else if (command === 'distribution' && args.length === 1) {
      console.log(`distribution=${distributionRelevant(readChangedPaths(args[0]))}`);
    } else if (command === 'release' && args.length === 1) {
      const verdict = releaseRelevance(readChangedPaths(args[0]));
      console.log(`release=${verdict.release}\nlauncher=${verdict.launcher}`);
    } else {
      throw new Error(
        'changed-paths: expected collect <base-sha> <head-sha> <file> | distribution <file> | release <file>'
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
