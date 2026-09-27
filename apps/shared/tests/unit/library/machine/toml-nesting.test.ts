import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getLibraryLocation } from '../../../../src/library/host';
import { LibraryCache, readLocationInstances } from '../../../../src/library/machine';
import {
  TOML_NESTING_LIMIT,
  tomlNestingWithinLimit,
} from '../../../../src/library/machine/toml-nesting';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mango-toml-nesting-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function nestedArrays(depth: number): unknown {
  let value: unknown = [];
  for (let level = 1; level < depth; level += 1) value = [value];
  return { a: value };
}

async function settingsVerdict(text: string): Promise<string | undefined> {
  const location = getLibraryLocation('codex-settings');
  if (!location) throw new Error('expected location codex-settings | received: undefined');
  const path = join(root, 'codex', 'config.toml');
  mkdirSync(join(root, 'codex'), { recursive: true });
  writeFileSync(path, text);
  const scanned = await readLocationInstances(location, path, {
    cache: new LibraryCache(),
    force: true,
  });
  const instance = scanned.instances[0]?.instance;
  return instance && 'invalidReason' in instance ? instance.invalidReason : undefined;
}

describe('tomlNestingWithinLimit', () => {
  it('counts containers below the root table, which is depth 0', () => {
    expect(TOML_NESTING_LIMIT).toBe(64);
    expect(tomlNestingWithinLimit(nestedArrays(64))).toBe(true);
    expect(tomlNestingWithinLimit(nestedArrays(65))).toBe(false);
  });

  it('treats a TOML date as a scalar, not a container', () => {
    let value: unknown = new Date(0);
    for (let level = 0; level < 64; level += 1) value = { k: value };
    expect(tomlNestingWithinLimit(value)).toBe(true);
  });

  it('walks half a million levels without exhausting the stack', () => {
    let value: Record<string, unknown> = {};
    for (let level = 0; level < 500_000; level += 1) value = { k: value };
    expect(tomlNestingWithinLimit(value)).toBe(false);
  });
});

describe('TOML metadata nesting', () => {
  it('reports a document nested past the limit as invalid-metadata', async () => {
    const deep = `a = ${'['.repeat(65)}${']'.repeat(65)}\n`;
    expect(await settingsVerdict(deep)).toBe('invalid-metadata');
    const atLimit = `a = ${'['.repeat(64)}${']'.repeat(64)}\n`;
    expect(await settingsVerdict(atLimit)).toBeUndefined();
  });
});
