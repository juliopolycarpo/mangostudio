import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';

import {
  PROTOCOL_CHANGELOG,
  PROTOCOL_CHANGELOG_GLOBS,
  PROTOCOL_CLIFF_CONFIG,
  PROTOCOL_PATHS,
} from '../lib/protocol';
import { readText } from './support/read-text';

// Two disjoint histories share this repository: the application's, and the
// Mango Protocol's, which arrived through one `--no-ff` merge of an unrelated
// root with its original SHAs. Each has its own changelog, and the rules below
// are the only thing keeping one out of the other. All three were measured
// against git-cliff 2.13.1.

const ROOT_CONFIG = readText('cliff.toml');
const PROTOCOL_CONFIG = readText(PROTOCOL_CLIFF_CONFIG);

function renderCanaryFixture(tags: readonly string[]): string {
  const repo = mkdtempSync(join(tmpdir(), 'cliff-canary-'));
  try {
    const git = (...args: string[]) => {
      const result = Bun.spawnSync({
        cmd: ['git', '-C', repo, ...args],
        stdout: 'pipe',
        stderr: 'pipe',
      });
      if (result.exitCode !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
      }
    };
    git('init', '-q', '-b', 'main');
    // A non-owner identity in an explicitly unsigned repo: the only shape the
    // local git wrapper lets a scratch commit through with.
    git('config', 'user.email', 'changelog-fixture@example.com');
    git('config', 'user.name', 'Changelog Fixture');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'a.txt'), 'a');
    git('add', '.');
    git('commit', '-q', '-m', 'feat: the released feature');
    git('tag', 'v1.0.0');
    writeFileSync(join(repo, 'b.txt'), 'b');
    git('add', '.');
    git('commit', '-q', '-m', 'fix: a fix that went green on main');
    for (const tag of tags) git('tag', tag);

    const cliff = Bun.spawnSync({
      cmd: ['bunx', 'git-cliff', '--config', join(ROOT_DIR, 'cliff.toml'), '--strip', 'header'],
      cwd: repo,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (cliff.exitCode !== 0) {
      throw new Error(`git-cliff failed: ${cliff.stderr.toString()}`);
    }
    return cliff.stdout.toString();
  } finally {
    rmSync(repo, { force: true, recursive: true });
  }
}

describe('changelog partition', () => {
  test('the two configs claim disjoint tag namespaces, both anchored', () => {
    // Unanchored, the root's `v[0-9]*` matched `protocol-v0.2.0` and resolved it
    // as an application release; the protocol's would match `v0.1.1` the same
    // way. Both anchors are load-bearing.
    expect(ROOT_CONFIG).toContain('tag_pattern = "^v[0-9]+');
    expect(PROTOCOL_CONFIG).toContain('tag_pattern = "^protocol-v[0-9]"');
  });

  test('the root excludes exactly what the protocol includes', () => {
    // One list, two configs. Every protocol directory is on it, and so is
    // anything the protocol owns outside them.
    for (const glob of PROTOCOL_CHANGELOG_GLOBS) {
      const quoted = `"${glob}"`;
      expect(ROOT_CONFIG, `root cliff.toml must exclude ${glob}`).toContain(quoted);
      expect(PROTOCOL_CONFIG, `protocol cliff.toml must include ${glob}`).toContain(quoted);
    }
    for (const prefix of PROTOCOL_PATHS) {
      expect(PROTOCOL_CHANGELOG_GLOBS, prefix).toContain(`${prefix}**`);
    }
  });

  test("the protocol's own workflows reach its changelog and not the application's", () => {
    // Measured before this rule existed: `ci(protocol): own CI, release and
    // fuzz workflows` touches nothing but `.github/workflows/protocol-*.yml`,
    // so it landed in CHANGELOG.md and in neither protocol section — the exact
    // inversion the partition exists to prevent. Four sibling commits on the
    // relocation branch had the same file shape.
    for (const config of [ROOT_CONFIG, PROTOCOL_CONFIG]) {
      expect(config).toContain('".github/workflows/protocol-*.yml"');
    }
  });

  test('the path rules use the plural config keys git-cliff actually reads', () => {
    // Measured: `exclude_path`/`include_path` are the CLI flag names. Spelled
    // that way in cliff.toml they are accepted without complaint and ignored —
    // the unreleased section stayed at 126 entries instead of falling to 79.
    expect(ROOT_CONFIG).toContain('exclude_paths = [');
    expect(ROOT_CONFIG).not.toMatch(/^exclude_path = /m);
    expect(PROTOCOL_CONFIG).toContain('include_paths = [');
    expect(PROTOCOL_CONFIG).not.toMatch(/^include_path = /m);
  });

  test('both bodies end with the seam marker a postprocessor removes', () => {
    // `trim = true` eats the trailing newline of each release body, so without
    // this the last bullet of one version and the next `## [x.y.z]` heading land
    // on consecutive lines.
    for (const [name, config] of [
      ['cliff.toml', ROOT_CONFIG],
      [PROTOCOL_CLIFF_CONFIG, PROTOCOL_CONFIG],
    ] as const) {
      expect(config, name).toContain('<!-- seam -->');
      expect(config, name).toContain(`{ pattern = '<!-- seam -->', replace = "" }`);
    }
  });

  test('a per-commit canary tag never opens a release section', () => {
    // Canary cuts one tag per green commit. The former broad `tag_pattern`
    // selected one as a release boundary and swallowed "Unreleased".
    const output = renderCanaryFixture(['v1.0.1-canary.abc1234']);

    expect(output).not.toContain('1.0.1-canary');
    // The commit is kept, not skipped: it belongs to whatever releases next.
    expect(output).toContain('## [Unreleased]');
    expect(output).toContain('A fix that went green on main');
  }, 30000);

  test('a real prerelease tag still opens its own release section', () => {
    const output = renderCanaryFixture(['v1.0.1-rc.1']);

    expect(output).toContain('## [1.0.1-rc.1]');
    expect(output).toContain('A fix that went green on main');
  }, 30000);

  test('a canary tag does not replace a stable section on the same commit', () => {
    const output = renderCanaryFixture(['v1.0.1-canary.abc1234', 'v1.0.1']);

    expect(output).not.toContain('1.0.1-canary');
    // Canary tags are excluded before git-cliff assigns commits to release
    // boundaries, so the stable tag still owns this fix.
    expect(output).toContain('## [1.0.1]');
    expect(output).not.toContain('## [Unreleased]');
    expect(output).toContain('A fix that went green on main');
  }, 30000);

  test('the protocol changelog is prepended to, never regenerated', () => {
    // Its 0.1.0 and 0.2.0 sections were generated upstream, before the tree
    // moved; regenerating returns 70 of the 87 committed entries and loses the
    // 0.1.0 boundary entirely.
    const prepare = readText('scripts/protocol/release-prepare.ts');
    expect(prepare).toContain("'--prepend',");
    expect(prepare).toContain("'--unreleased',");
    expect(prepare).not.toContain("'--output',");
  });

  test('the committed protocol changelog still carries both imported releases', () => {
    const changelog = readText(PROTOCOL_CHANGELOG);
    expect(changelog).toContain('## [0.2.0]');
    expect(changelog).toContain('## [0.1.0]');
  });

  test('the protocol heading strips the whole tag prefix, not just the v', () => {
    // `trim_start_matches(pat="v")` leaves `protocol-v0.2.0` as the heading.
    expect(PROTOCOL_CONFIG).toContain('trim_start_matches(pat="protocol-v")');
  });
});
