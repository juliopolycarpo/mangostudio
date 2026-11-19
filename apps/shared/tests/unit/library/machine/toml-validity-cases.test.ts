import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getLibraryLocation } from '../../../../src/library/host';
import { LibraryCache, readLocationInstances } from '../../../../src/library/machine';

/**
 * The case table the Rust runtime replays in `src/library/toml_document.rs`.
 * One file decides which library TOML documents are valid, so a parser change
 * on either host fails a test on that host instead of drifting silently.
 */
const CASES_PATH = join(
  import.meta.dir,
  '../../../../../../crates/mangostudio-runtime/tests/fixtures/library-toml/validity-cases.json'
);

interface ValidityCase {
  readonly name: string;
  readonly document: string;
  readonly valid: boolean;
  readonly note?: string;
}

const cases = (JSON.parse(readFileSync(CASES_PATH, 'utf8')) as { cases: ValidityCase[] }).cases;

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mango-toml-validity-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

async function scanAgent(document: string) {
  const definition = getLibraryLocation('codex-agents');
  if (!definition) throw new Error('Expected library location codex-agents, received undefined.');
  writeFileSync(join(directory, 'subject.toml'), document);
  const result = await readLocationInstances(definition, directory, {
    cache: new LibraryCache(),
    force: true,
  });
  expect(result.instances).toHaveLength(1);
  return result.instances[0]?.instance;
}

describe('library TOML validity case table', () => {
  it('names every case once and gives each a verdict', () => {
    const names = cases.map((entry) => entry.name);
    expect(cases.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
    for (const entry of cases) {
      expect(typeof entry.valid, `case ${entry.name}: expected a boolean valid`).toBe('boolean');
    }
  });

  it.each(cases)('the hub reads $name as its table verdict', async (entry) => {
    const instance = await scanAgent(entry.document);
    const invalidReason = instance && !instance.valid ? instance.invalidReason : undefined;

    expect(
      instance?.valid,
      `case ${entry.name} (${JSON.stringify(entry.document)}): expected valid=${entry.valid} | received valid=${instance?.valid} invalidReason=${invalidReason}`
    ).toBe(entry.valid);
    if (!entry.valid) expect(invalidReason).toBe('invalid-metadata');
  });
});
