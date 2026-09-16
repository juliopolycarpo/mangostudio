import { describe, expect, test } from 'bun:test';

import { PROTOCOL_CHANGELOG, PROTOCOL_CLIFF_CONFIG, PROTOCOL_PATHS } from '../lib/protocol';
import { readText } from './support/read-text';

// Two disjoint histories share this repository: the application's, and the
// Mango Protocol's, which arrived through one `--no-ff` merge of an unrelated
// root with its original SHAs. Each has its own changelog, and the rules below
// are the only thing keeping one out of the other. All three were measured
// against git-cliff 2.13.1.

const ROOT_CONFIG = readText('cliff.toml');
const PROTOCOL_CONFIG = readText(PROTOCOL_CLIFF_CONFIG);

describe('changelog partition', () => {
  test('the two configs claim disjoint tag namespaces, both anchored', () => {
    // Unanchored, the root's `v[0-9]*` matched `protocol-v0.2.0` and resolved it
    // as an application release; the protocol's would match `v0.1.1` the same
    // way. Both anchors are load-bearing.
    expect(ROOT_CONFIG).toContain('tag_pattern = "^v[0-9]"');
    expect(PROTOCOL_CONFIG).toContain('tag_pattern = "^protocol-v[0-9]"');
  });

  test('the root excludes exactly the directories the protocol includes', () => {
    // One list, three consumers: these two configs and the CI path filter.
    for (const prefix of PROTOCOL_PATHS) {
      const glob = `"${prefix}**"`;
      expect(ROOT_CONFIG, `root cliff.toml must exclude ${prefix}`).toContain(glob);
      expect(PROTOCOL_CONFIG, `protocol cliff.toml must include ${prefix}`).toContain(glob);
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
