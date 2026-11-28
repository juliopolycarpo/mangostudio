import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { createGitPathsBetween } from '../ci/codeql-rust-coverage';
import { decideRustLegsForPush } from '../lib/codeql-rust-coverage';
import { useScratchDirs } from './support/scratch-dirs';

const makeDir = useScratchDirs();

/** A throwaway repository whose commits are made from `{ path: content }` snapshots. */
class FakeRepository {
  constructor(readonly directory: string) {
    this.git(['init', '-q', '-b', 'main']);
    this.git(['config', 'user.email', 'fixture@example.invalid']);
    this.git(['config', 'user.name', 'fixture']);
    this.git(['config', 'commit.gpgsign', 'false']);
  }
  git(args: string[]): string {
    const result = Bun.spawnSync(['git', ...args], {
      cwd: this.directory,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(
      result.exitCode,
      `git ${args.join(' ')}: expected exit 0 | received ${result.exitCode}: ${result.stderr.toString()}`
    ).toBe(0);
    return result.stdout.toString().trim();
  }
  commit(files: Record<string, string>): string {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(this.directory, path)), { recursive: true });
      writeFileSync(join(this.directory, path), content);
    }
    this.git(['add', '-A']);
    this.git(['commit', '-q', '--allow-empty', '-m', 'fixture']);
    return this.git(['rev-parse', 'HEAD']);
  }
}

function repository(): FakeRepository {
  return new FakeRepository(makeDir('codeql-rust-coverage-'));
}

describe('createGitPathsBetween', () => {
  test('lists both sides of a rename and every changed path', () => {
    const repo = repository();
    const base = repo.commit({ 'crates/a/src/lib.rs': 'fn a() {}\n', 'README.md': 'one\n' });
    repo.git(['mv', 'crates/a/src/lib.rs', 'crates/a/src/main.rs']);
    const head = repo.commit({ 'README.md': 'two\n' });
    expect([...(createGitPathsBetween(repo.directory)(base, head) ?? [])].sort()).toEqual([
      'README.md',
      'crates/a/src/lib.rs',
      'crates/a/src/main.rs',
    ]);
  });

  test('identical trees give an empty list, not an error', () => {
    const repo = repository();
    const base = repo.commit({ 'README.md': 'one\n' });
    const head = repo.commit({});
    expect(createGitPathsBetween(repo.directory)(base, head)).toEqual([]);
  });

  test('a commit missing from the clone is unproven', () => {
    const repo = repository();
    const head = repo.commit({ 'README.md': 'one\n' });
    expect(createGitPathsBetween(repo.directory)('9'.repeat(40), head)).toBeUndefined();
  });
});

describe('the push decision over real history', () => {
  function decide(repo: FakeRepository, analyzed: string, head: string) {
    return decideRustLegsForPush({
      head,
      repository: 'owner/repo',
      fetchPage: () =>
        ['/language:rust', '/language:rust/windows'].map((category) => ({
          ref: 'refs/heads/main',
          commit_sha: analyzed,
          analysis_key: '.github/workflows/codeql.yml:analyze-rust',
          category,
          error: '',
          created_at: '2026-11-20T10:00:00Z',
          tool: { name: 'CodeQL' },
        })),
      pathsBetween: createGitPathsBetween(repo.directory),
    });
  }

  test('a docs commit after the analyzed commit skips the Rust legs', () => {
    const repo = repository();
    const analyzed = repo.commit({ 'crates/a/src/lib.rs': 'fn a() {}\n' });
    const docs = repo.commit({ 'docs/guide.md': 'text\n' });
    expect(decide(repo, analyzed, docs).rust).toBe(false);
  });

  test('a docs commit that follows a Rust commit whose analysis was cancelled still analyzes Rust', () => {
    const repo = repository();
    const analyzed = repo.commit({ 'crates/a/src/lib.rs': 'fn a() {}\n' });
    // Commit A changes Rust but its main run was superseded: no analysis exists for it.
    repo.commit({ 'crates/a/src/lib.rs': 'fn a() { panic!() }\n' });
    const docs = repo.commit({ 'docs/guide.md': 'text\n' });
    const decision = decide(repo, analyzed, docs);
    expect(decision.rust).toBe(true);
    expect(decision.reason).toContain('Rust-relevant change');
  });

  test('a revert of the unanalyzed Rust change is covered again', () => {
    const repo = repository();
    const analyzed = repo.commit({ 'crates/a/src/lib.rs': 'fn a() {}\n' });
    repo.commit({ 'crates/a/src/lib.rs': 'fn a() { panic!() }\n' });
    const reverted = repo.commit({ 'crates/a/src/lib.rs': 'fn a() {}\n' });
    expect(decide(repo, analyzed, reverted).rust).toBe(false);
  });

  test('an analyzed commit that history no longer holds forces analysis', () => {
    const repo = repository();
    const head = repo.commit({ 'docs/guide.md': 'text\n' });
    const decision = decide(repo, 'a'.repeat(40), head);
    expect(decision.rust).toBe(true);
    expect(decision.reason).toContain('(difference unproven)');
  });
});

describe('codeql-rust-coverage command', () => {
  const script = join(import.meta.dir, '../ci/codeql-rust-coverage.ts');
  function run(args: string[], env: Record<string, string>) {
    const result = Bun.spawnSync(['bun', script, ...args], {
      env: { PATH: process.env.PATH ?? '', ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  }

  test('malformed inputs analyze Rust and name the received values', () => {
    const result = run(['push'], { HEAD_SHA: 'main', REPO: 'not a repo' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('rust=true\n');
    expect(result.stderr).toContain(
      'expected 40-hex HEAD_SHA and owner/repo REPO; received {"head":"main","repository":"not a repo"}'
    );
  });

  test('an unknown command fails and names the received command', () => {
    const result = run(['pull_request'], {});
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('expected command push; received "pull_request"');
  });
});
