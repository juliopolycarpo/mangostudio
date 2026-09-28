import { describe, expect, test } from 'bun:test';
import {
  assertChangelogHasRelease,
  type CliffResult,
  cliffArgs,
  countChangelogEntries,
  PREVIEW_MARKER,
  parseChangelogArgs,
  releaseHeading,
  renderChangelogPreviewSection,
  runChangelog,
  wrapPreviewComment,
} from '../lib/changelog';
import { PROTOCOL_IMPORT_TIP } from '../lib/protocol';

// Fixed baseline so the parser tests do not depend on the root package.json.
const BASELINE_VERSION = '0.1.0';

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
  test('init targets the resolved version and writes CHANGELOG.md', () => {
    expect(cliffArgs({ kind: 'init', version: '0.1.0' })).toEqual([
      '--tag',
      'v0.1.0',
      '--output',
      'CHANGELOG.md',
      `${PROTOCOL_IMPORT_TIP}..HEAD`,
    ]);
    expect(cliffArgs({ kind: 'init', version: 'v2.0.0' })).toEqual([
      '--tag',
      'v2.0.0',
      '--output',
      'CHANGELOG.md',
      `${PROTOCOL_IMPORT_TIP}..HEAD`,
    ]);
  });

  test('release normalizes a leading v and writes CHANGELOG.md', () => {
    expect(cliffArgs({ kind: 'release', version: 'v1.2.3' })).toEqual([
      '--tag',
      'v1.2.3',
      '--output',
      'CHANGELOG.md',
      `${PROTOCOL_IMPORT_TIP}..HEAD`,
    ]);
    expect(cliffArgs({ kind: 'release', version: '1.2.3' })).toEqual([
      '--tag',
      'v1.2.3',
      '--output',
      'CHANGELOG.md',
      `${PROTOCOL_IMPORT_TIP}..HEAD`,
    ]);
  });

  test('preview strips boilerplate and scopes to base..head', () => {
    expect(cliffArgs({ kind: 'preview', base: 'origin/main', head: 'HEAD' })).toEqual([
      '--strip',
      'all',
      'origin/main..HEAD',
    ]);
    expect(cliffArgs({ kind: 'preview', base: 'abc123', head: 'def456' })).toEqual([
      '--strip',
      'all',
      'abc123..def456',
    ]);
  });
});

describe('parseChangelogArgs', () => {
  test('parses each mode', () => {
    expect(parseChangelogArgs(['--init'], BASELINE_VERSION)).toEqual({
      kind: 'init',
      version: BASELINE_VERSION,
    });
    expect(parseChangelogArgs(['--release', '0.2.0'], BASELINE_VERSION)).toEqual({
      kind: 'release',
      version: '0.2.0',
    });
    expect(parseChangelogArgs(['--preview'], BASELINE_VERSION)).toEqual({
      kind: 'preview',
      base: 'origin/main',
      head: 'HEAD',
    });
    expect(parseChangelogArgs(['--preview', '--base', 'abc123'], BASELINE_VERSION)).toEqual({
      kind: 'preview',
      base: 'abc123',
      head: 'HEAD',
    });
    expect(
      parseChangelogArgs(['--preview', '--base', 'abc123', '--head', 'def456'], BASELINE_VERSION)
    ).toEqual({
      kind: 'preview',
      base: 'abc123',
      head: 'def456',
    });
  });

  test('init takes an explicit version override before the resolved baseline', () => {
    expect(parseChangelogArgs(['--init', '9.9.9'], BASELINE_VERSION)).toEqual({
      kind: 'init',
      version: '9.9.9',
    });
  });

  test('returns null for help, empty, or a missing release version', () => {
    expect(parseChangelogArgs([], BASELINE_VERSION)).toBeNull();
    expect(parseChangelogArgs(['--help'], BASELINE_VERSION)).toBeNull();
    expect(parseChangelogArgs(['--release'], BASELINE_VERSION)).toBeNull();
    expect(parseChangelogArgs(['--release', '--base'], BASELINE_VERSION)).toBeNull();
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

const cliffBody = (entries: number): string =>
  [
    '## [Unreleased]',
    '',
    '### 🚀 Features',
    '',
    ...Array.from({ length: entries }, (_, index) => `- **(api)** Entry ${index + 1}`),
    '',
  ].join('\n');

describe('countChangelogEntries', () => {
  test('counts one entry per top-level bullet, not headings or blank lines', () => {
    expect(countChangelogEntries(cliffBody(3))).toBe(3);
    expect(countChangelogEntries('')).toBe(0);
    expect(countChangelogEntries('## [Unreleased]\n\n### Features\n')).toBe(0);
  });

  test('ignores wrapped and nested continuation lines', () => {
    const body = [
      '### Fixes',
      '',
      '- first entry that',
      '  wraps onto a second line',
      '  - nested',
    ];
    expect(countChangelogEntries(body.join('\n'))).toBe(1);
  });

  test('counts entries across several groups', () => {
    const body = '### A\n\n- one\n- two\n\n### B\n\n- three\n';
    expect(countChangelogEntries(body)).toBe(3);
  });
});

describe('renderChangelogPreviewSection', () => {
  const folded = (section: string): boolean => section.includes('<details>');

  test('never folds without a collapseAbove option (local --preview CLI)', () => {
    expect(folded(renderChangelogPreviewSection(cliffBody(30)))).toBe(false);
  });

  test('stays expanded at five entries and folds at six', () => {
    const at5 = renderChangelogPreviewSection(cliffBody(5), { collapseAbove: 5 });
    const at6 = renderChangelogPreviewSection(cliffBody(6), { collapseAbove: 5 });

    expect(folded(at5)).toBe(false);
    expect(folded(at6)).toBe(true);
    expect(at6).toContain('<summary>6 changelog entries</summary>');
    expect(at6).toContain('## 📝 Changelog Preview');
    expect(at6).toContain('- **(api)** Entry 6');
  });

  test.each(['  ', '## [Unreleased]\n\n### 🚀 Features\n'])(
    'renders the empty placeholder, expanded, for an entry-free body %p',
    (body) => {
      const section = renderChangelogPreviewSection(body, { collapseAbove: 5 });

      expect(section).toContain('No changelog-relevant commits');
      expect(section).not.toContain('### 🚀 Features');
      expect(folded(section)).toBe(false);
    }
  );

  test('truncates at a line boundary before folding so the details block stays closed', () => {
    const section = renderChangelogPreviewSection(cliffBody(40), {
      collapseAbove: 5,
      maxLength: 200,
    });

    expect(section).toContain('_…changelog preview truncated…_');
    expect(section.trimEnd().endsWith('</details>')).toBe(true);
    expect(section).toContain('<summary>40 changelog entries</summary>');
    expect(section).not.toContain('Entry 40');
    const keptEntries = section.split('\n').filter((line) => line.startsWith('- '));
    expect(keptEntries.every((line) => /^- \*\*\(api\)\*\* Entry \d+$/.test(line))).toBe(true);
  });
});

describe('releaseHeading', () => {
  test('matches the cliff.toml body template and normalizes a leading v', () => {
    expect(releaseHeading('0.1.0')).toBe('## [0.1.0]');
    expect(releaseHeading('v0.1.0')).toBe('## [0.1.0]');
  });
});

describe('assertChangelogHasRelease', () => {
  const changelog = [
    '# Changelog',
    '',
    '## [0.2.0] - 2026-07-05',
    '',
    '### 🚀 Features',
    '',
    '- New thing',
    '',
    '## [0.1.0] - 2026-06-30',
    '',
  ].join('\n');

  test('passes when the release section is present', () => {
    expect(() => assertChangelogHasRelease(changelog, '0.2.0')).not.toThrow();
    expect(() => assertChangelogHasRelease(changelog, 'v0.1.0')).not.toThrow();
  });

  test('fails with the release:prepare fix when the section is missing', () => {
    expect(() => assertChangelogHasRelease(changelog, '0.3.0')).toThrow(
      /no "## \[0\.3\.0\]" release section[\s\S]*bun run release:prepare 0\.3\.0/
    );
  });

  test('a prerelease heading never satisfies the stable release gate', () => {
    const prerelease = '## [0.3.0-rc.1] - 2026-07-05\n';
    expect(() => assertChangelogHasRelease(prerelease, '0.3.0')).toThrow(/release section/);
  });
});

describe('runChangelog', () => {
  test('preview wraps git-cliff stdout as a comment', () => {
    const fake = new FakeCliff({ stdout: '### Features\n- new', exitCode: 0 });
    const { output, exitCode } = runChangelog(
      { kind: 'preview', base: 'origin/main', head: 'HEAD' },
      fake.run
    );
    expect(fake.lastArgs).toEqual(['--strip', 'all', 'origin/main..HEAD']);
    expect(output).toContain('### Features');
    expect(output).toContain(PREVIEW_MARKER);
    expect(exitCode).toBe(0);
  });

  test('init passes git-cliff output through and propagates exit code', () => {
    const fake = new FakeCliff({ stdout: '', exitCode: 0 });
    const { output, exitCode } = runChangelog({ kind: 'init', version: '0.1.0' }, fake.run);
    expect(fake.lastArgs).toEqual([
      '--tag',
      'v0.1.0',
      '--output',
      'CHANGELOG.md',
      `${PROTOCOL_IMPORT_TIP}..HEAD`,
    ]);
    expect(output).toBe('');
    expect(exitCode).toBe(0);
  });
});
