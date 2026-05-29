import { describe, expect, test } from 'bun:test';
import {
  type CliffResult,
  cliffArgs,
  INITIAL_VERSION,
  PREVIEW_MARKER,
  parseChangelogArgs,
  runChangelog,
  wrapPreviewComment,
} from '../lib/changelog';

// Named fake git-cliff runner: records the args it received and returns a
// scripted result, so the wrapper is tested without invoking the real binary.
class FakeCliff {
  public lastArgs: readonly string[] = [];
  constructor(private readonly result: CliffResult) {}
  run = (args: readonly string[]): CliffResult => {
    this.lastArgs = args;
    return this.result;
  };
}

describe('cliffArgs', () => {
  test('init targets the baseline version and writes CHANGELOG.md', () => {
    expect(cliffArgs({ kind: 'init' })).toEqual([
      '--tag',
      `v${INITIAL_VERSION}`,
      '--output',
      'CHANGELOG.md',
    ]);
  });

  test('release normalizes a leading v and writes CHANGELOG.md', () => {
    expect(cliffArgs({ kind: 'release', version: 'v1.2.3' })).toEqual([
      '--tag',
      'v1.2.3',
      '--output',
      'CHANGELOG.md',
    ]);
    expect(cliffArgs({ kind: 'release', version: '1.2.3' })).toEqual([
      '--tag',
      'v1.2.3',
      '--output',
      'CHANGELOG.md',
    ]);
  });

  test('preview strips boilerplate and scopes to base..HEAD', () => {
    expect(cliffArgs({ kind: 'preview', base: 'origin/main' })).toEqual([
      '--strip',
      'all',
      'origin/main..HEAD',
    ]);
  });
});

describe('parseChangelogArgs', () => {
  test('parses each mode', () => {
    expect(parseChangelogArgs(['--init'])).toEqual({ kind: 'init' });
    expect(parseChangelogArgs(['--release', '0.2.0'])).toEqual({
      kind: 'release',
      version: '0.2.0',
    });
    expect(parseChangelogArgs(['--preview'])).toEqual({ kind: 'preview', base: 'origin/main' });
    expect(parseChangelogArgs(['--preview', '--base', 'abc123'])).toEqual({
      kind: 'preview',
      base: 'abc123',
    });
  });

  test('returns null for help, empty, or a missing release version', () => {
    expect(parseChangelogArgs([])).toBeNull();
    expect(parseChangelogArgs(['--help'])).toBeNull();
    expect(parseChangelogArgs(['--release'])).toBeNull();
    expect(parseChangelogArgs(['--release', '--base'])).toBeNull();
  });
});

describe('wrapPreviewComment', () => {
  test('includes the heading and trailing marker', () => {
    const out = wrapPreviewComment('### Features\n- thing');
    expect(out).toContain('## 📝 Changelog Preview');
    expect(out).toContain('### Features');
    expect(out.endsWith(PREVIEW_MARKER)).toBe(true);
  });

  test('falls back to a placeholder for empty bodies', () => {
    expect(wrapPreviewComment('   ')).toContain('No changelog-relevant commits');
  });
});

describe('runChangelog', () => {
  test('preview wraps git-cliff stdout as a comment', () => {
    const fake = new FakeCliff({ stdout: '### Features\n- new', exitCode: 0 });
    const { output, exitCode } = runChangelog({ kind: 'preview', base: 'origin/main' }, fake.run);
    expect(fake.lastArgs).toEqual(['--strip', 'all', 'origin/main..HEAD']);
    expect(output).toContain('### Features');
    expect(output).toContain(PREVIEW_MARKER);
    expect(exitCode).toBe(0);
  });

  test('init passes git-cliff output through and propagates exit code', () => {
    const fake = new FakeCliff({ stdout: '', exitCode: 0 });
    const { output, exitCode } = runChangelog({ kind: 'init' }, fake.run);
    expect(fake.lastArgs).toEqual(['--tag', 'v0.1.0', '--output', 'CHANGELOG.md']);
    expect(output).toBe('');
    expect(exitCode).toBe(0);
  });
});
