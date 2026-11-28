import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { codeqlRustRelevant } from '../lib/ci-lanes';
import { collectRustIncludeTargets, rustIncludeTargets } from './support/rust-include-targets';

const ROOT = join(import.meta.dir, '../..');

describe('rustIncludeTargets', () => {
  test('resolves a manifest-relative concat! target against the crate root', () => {
    const source = `const X: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../spec/a.json"));`;
    expect(rustIncludeTargets('crates/a/src/x.rs', 'crates/a', source)).toEqual(['spec/a.json']);
  });

  test('resolves a plain path against the including file', () => {
    expect(
      rustIncludeTargets('crates/a/src/x.rs', 'crates/a', 'include_bytes!("../data/b.bin")')
    ).toEqual(['crates/a/data/b.bin']);
  });

  test('skips generated OUT_DIR files', () => {
    const source = 'include_str!(concat!(env!("OUT_DIR"), "/catalog.json"))';
    expect(rustIncludeTargets('crates/a/src/x.rs', 'crates/a', source)).toEqual([]);
  });

  test('reads the join literals of a build script', () => {
    const source = 'let p = manifest.join("../../apps/shared/src/generated/catalog.json");';
    expect(rustIncludeTargets('crates/a/build.rs', 'crates/a', source)).toEqual([
      'apps/shared/src/generated/catalog.json',
    ]);
    expect(rustIncludeTargets('crates/a/src/x.rs', 'crates/a', source)).toEqual([]);
  });
});

describe('CodeQL Rust relevance covers every file the crates read at compile time', () => {
  const targets = collectRustIncludeTargets(ROOT);

  test('the scan finds the known outside-crate inputs, so an empty scan cannot pass', () => {
    expect([...targets.keys()]).toEqual(
      expect.arrayContaining([
        'apps/shared/src/external-agents/login.json',
        'apps/shared/src/runtime-contract/generated/catalog.json',
        'spec/schema/1/protocol.json',
        'scripts/tests/support/SHA256SUMS.sample',
      ])
    );
  });

  test('every include target is Rust-relevant, so changing it runs the Rust legs', () => {
    // A directory target gets a file name appended at run time; probe with one.
    const outside = [...targets]
      .filter(([target]) => !codeqlRustRelevant([target.endsWith('/') ? `${target}file` : target]))
      .map(([target, reader]) => `${target} (read by ${reader})`);
    expect(
      outside,
      `include_str!/include_bytes!/build.rs inputs outside CODEQL_RUST_PATTERN: expected none | received ${JSON.stringify(outside)}; add them to CODEQL_RUST_PATTERN in scripts/lib/ci-lanes.ts`
    ).toEqual([]);
  });

  test('every named include target exists, so the scan resolves paths correctly', () => {
    const missing = [...targets.keys()].filter(
      (target) => !target.endsWith('/') && !existsSync(join(ROOT, target))
    );
    expect(missing, `unresolved include targets: ${JSON.stringify(missing)}`).toEqual([]);
  });
});
