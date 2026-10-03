import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { en } from '../../src/i18n';

// The Rust runtime names frontend i18n keys it sends over the wire (the
// external-agent "unsupported" reasons and the approval option labels). The
// Rust test `every_key_in_the_table_is_one_the_frontend_ships` guards
// Rust -> catalog whenever Rust changes; this test guards catalog -> Rust, so
// removing or renaming a key in `en.ts` fails the shared lane that already runs
// on that edit instead of waiting for the Rust lanes, which an `en.ts` edit
// deliberately does not trigger (see RUST_WORKSPACE_PATHS in
// scripts/lib/rust-lanes.ts and CRATE_INPUTS_COVERED_ELSEWHERE in
// scripts/tests/rust-lanes.unit.test.ts).

const REPO_ROOT = join(import.meta.dir, '../../../..');
const AGENTS_DIR = 'crates/mangostudio-runtime/src/external_agents/adapter';
const UNSUPPORTED_PREFIX = 'externalAgents.unsupported.';

/**
 * Every full `externalAgents.*` i18n key written as a string literal in `text`.
 *
 * @example
 * fullKeys('const A: &str = "externalAgents.unsupported.claudeModeMissing";');
 * // ['externalAgents.unsupported.claudeModeMissing']
 */
function fullKeys(text: string): string[] {
  return [...text.matchAll(/"(externalAgents\.[A-Za-z]+(?:\.[A-Za-z]+)+)"/g)].map(
    (match) => match[1] as string
  );
}

/**
 * The leaf of every row of the Rust `KEY_TABLE`, as full `unsupported` keys.
 * A row is five string literals; the fifth is the leaf.
 *
 * @example
 * tableKeys('const KEY_TABLE: &[(..)] = &[("a", "b", "c", "d", "leaf")];');
 * // ['externalAgents.unsupported.leaf']
 */
function tableKeys(text: string): string[] {
  const start = text.indexOf('const KEY_TABLE');
  if (start === -1) return [];
  const body = text.slice(text.indexOf('= &[', start), text.indexOf('\n];', start));
  const literals = [...body.matchAll(/"([^"\n]*)"/g)].map((match) => match[1] as string);
  return literals.filter((_, index) => index % 5 === 4).map((leaf) => UNSUPPORTED_PREFIX + leaf);
}

/**
 * The English message at a dotted key of the catalog, read through the real
 * `en` export, or `undefined` when any segment is missing.
 *
 * @example
 * catalogMessage(en, 'externalAgents.unsupported.codexVersionTooOld'); // 'The Codex CLI ...'
 */
function catalogMessage(catalog: unknown, key: string): unknown {
  let node = catalog;
  for (const segment of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/** Keys of the catalog the Rust runtime names, each with the file that names it. */
function rustNamedKeys(): Array<{ key: string; source: string }> {
  const read = (file: string) => readFileSync(join(REPO_ROOT, AGENTS_DIR, file), 'utf8');
  const found: Array<{ key: string; source: string }> = [];
  for (const file of ['map.rs', 'map_events.rs']) {
    for (const key of fullKeys(read(file))) found.push({ key, source: `${AGENTS_DIR}/${file}` });
  }
  for (const key of tableKeys(read('map_tests.rs'))) {
    found.push({ key, source: `${AGENTS_DIR}/map_tests.rs (KEY_TABLE)` });
  }
  return found;
}

describe('i18n keys the Rust runtime names', () => {
  it('finds the known keys, so a broken extractor cannot pass vacuously', () => {
    const keys = new Set(rustNamedKeys().map((entry) => entry.key));
    for (const known of [
      'externalAgents.unsupported.claudeVersionTooOld',
      'externalAgents.unsupported.cursorAcpUnavailable',
      'externalAgents.unsupported.cursorNoAutoReview',
      'externalAgents.approval.option.acceptForSession',
    ]) {
      expect(
        keys.has(known),
        `expected the scan to find ${known} | received: ${keys.size} keys`
      ).toBe(true);
    }
    expect(keys.size).toBeGreaterThanOrEqual(15);
  });

  it('every one exists in the English catalog', () => {
    const missing = rustNamedKeys()
      .filter(({ key }) => typeof catalogMessage(en, key) !== 'string')
      .map(({ key, source }) => `${key} (named in ${source})`);
    expect(
      missing,
      `expected every Rust-named key in en.ts | received missing: ${missing.join(', ')}`
    ).toEqual([]);
  });

  it('reads a catalog through dotted keys and rejects a missing segment', () => {
    const catalog = { a: { b: 'leaf' } };
    expect(catalogMessage(catalog, 'a.b')).toBe('leaf');
    expect(catalogMessage(catalog, 'a.c')).toBeUndefined();
    expect(catalogMessage(catalog, 'a.b.c')).toBeUndefined();
  });

  it('extracts full keys and table leaves from Rust text', () => {
    expect(fullKeys('x "externalAgents.approval.option.accept"; "other.key"')).toEqual([
      'externalAgents.approval.option.accept',
    ]);
    const table =
      'const KEY_TABLE: &[(&str,)] = &[\n  ("a", "b", "c", "d", "leafOne"),\n  ("e", "f", "g", "h", "leafTwo"),\n];';
    expect(tableKeys(table)).toEqual([
      'externalAgents.unsupported.leafOne',
      'externalAgents.unsupported.leafTwo',
    ]);
    expect(tableKeys('no table here')).toEqual([]);
  });
});
