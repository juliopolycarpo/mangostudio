import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import { canaryReleaseVersion } from '../lib/release-version';
import {
  RELEASE_STAMP_MAGIC,
  RELEASE_STAMP_SLOT_BYTES,
  RELEASE_STAMP_VALUE_CAPACITY,
} from '../lib/runtime-stamp';

// The patcher (`scripts/lib/runtime-stamp.ts`) and the runtime (`src/main.rs`, `src/release_stamp.rs`)
// describe one slot in two languages. These tests pin the two descriptions to each other.

const RUNTIME_SOURCE = join(ROOT_DIR, 'crates/mangostudio-runtime/src');

function rustConstant(file: string, name: string): string | undefined {
  const source = readFileSync(join(RUNTIME_SOURCE, file), 'utf8');
  return new RegExp(`pub const ${name}: usize = ([^;]+);`).exec(source)?.[1];
}

describe('release stamp layout', () => {
  test('the magic is the one src/main.rs links in', () => {
    const source = readFileSync(join(RUNTIME_SOURCE, 'main.rs'), 'utf8');
    const declaration = /const STAMP_MAGIC: \[u8; MAGIC_LEN\] = \[([^\]]*)\];/.exec(source);
    expect(
      declaration,
      'expected main.rs to declare `const STAMP_MAGIC: [u8; MAGIC_LEN] = [..];`'
    ).not.toBeNull();

    const rustMagic = (declaration?.[1] ?? '')
      .split(',')
      .map((token) => token.trim())
      .filter(Boolean)
      .map((token) => Number.parseInt(token, 16));

    expect(rustMagic).toEqual([...RELEASE_STAMP_MAGIC]);
  });

  test('the capacities are the ones release_stamp.rs reads', () => {
    expect(rustConstant('release_stamp.rs', 'MAGIC_LEN')).toBe(String(RELEASE_STAMP_MAGIC.length));
    expect(rustConstant('release_stamp.rs', 'VALUE_CAPACITY')).toBe(
      String(RELEASE_STAMP_VALUE_CAPACITY)
    );
    expect(rustConstant('release_stamp.rs', 'SLOT_LEN')).toBe('MAGIC_LEN + 1 + VALUE_CAPACITY');
    expect(RELEASE_STAMP_SLOT_BYTES).toBe(
      RELEASE_STAMP_MAGIC.length + 1 + RELEASE_STAMP_VALUE_CAPACITY
    );
  });

  test('a canary version, the longest the pipeline derives from a commit, fits the field', () => {
    // `<root>-canary.<sha7>`, with the `g` prefix a numeric short sha with a leading zero takes.
    for (const sha of ['0123456789abcdef', 'ffffffffffffffff', '1234567']) {
      const canary = canaryReleaseVersion(sha);
      expect(
        canary.length,
        `expected canary version of at most ${RELEASE_STAMP_VALUE_CAPACITY} bytes | received: ${canary}`
      ).toBeLessThanOrEqual(RELEASE_STAMP_VALUE_CAPACITY);
    }
  });
});
