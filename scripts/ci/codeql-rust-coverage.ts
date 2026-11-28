#!/usr/bin/env bun
// Dependency-free: the changes job of codeql.yml runs this before bun install.
// `push` decides whether a main push needs the CodeQL Rust legs and prints
// `rust=true|false` for $GITHUB_OUTPUT. Environment: HEAD_SHA, REPO, and GH_TOKEN
// for gh. It needs a full-history checkout; a commit git cannot diff against is
// not a candidate. Any failure prints rust=true: the fail-safe is to analyze.
import { decodeChangedPaths } from '../lib/changed-paths';
import {
  decideRustLegsForPush,
  type FetchAnalysesPage,
  type PathsBetween,
} from '../lib/codeql-rust-coverage';

/**
 * Tree difference from local git in `cwd`; undefined when either commit is missing.
 * @example
 * createGitPathsBetween('/work/repo')(baseSha, headSha); // ['Cargo.toml']
 */
export function createGitPathsBetween(cwd?: string): PathsBetween {
  return (base, head) => {
    const diff = Bun.spawnSync(
      ['git', 'diff', '--no-renames', '--name-only', '-z', base, head, '--'],
      { cwd, stdout: 'pipe', stderr: 'pipe' }
    );
    if (diff.exitCode !== 0) return undefined;
    // An empty diff is the proof of identical trees, unlike for a pull request
    // where decodeChangedPaths refuses it to avoid skipping on a failed collect.
    return diff.stdout.length === 0 ? [] : decodeChangedPaths(diff.stdout);
  };
}

const ghFetchPage: FetchAnalysesPage = (path) => {
  const result = Bun.spawnSync(['gh', 'api', path], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(
      `gh api ${path} failed (${result.exitCode}): ${result.stderr.toString().trim()}`
    );
  }
  return JSON.parse(result.stdout.toString());
};

if (import.meta.main) {
  const [command] = process.argv.slice(2);
  if (command !== 'push') {
    console.error(
      `codeql-rust-coverage: expected command push; received ${JSON.stringify(command)}`
    );
    process.exit(1);
  }
  const head = process.env.HEAD_SHA ?? '';
  const repository = process.env.REPO ?? '';
  if (!/^[a-f0-9]{40}$/.test(head) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    console.log('rust=true');
    console.error(
      `::warning::codeql-rust-coverage: expected 40-hex HEAD_SHA and owner/repo REPO; received ${JSON.stringify({ head, repository })}; analyzing Rust`
    );
    process.exit(0);
  }
  const decision = decideRustLegsForPush({
    head,
    repository,
    fetchPage: ghFetchPage,
    pathsBetween: createGitPathsBetween(),
  });
  console.log(`rust=${decision.rust}`);
  console.error(`codeql-rust-coverage: rust=${decision.rust}: ${decision.reason}`);
}
