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

function tableWithScalar(value: unknown, depth: number): unknown {
  let table: unknown = { scalar: value };
  for (let level = 0; level < depth; level += 1) table = { k: table };
  return table;
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
  expect(scanned.instances).toHaveLength(1);
  const instance = scanned.instances[0]?.instance;
  return instance && 'invalidReason' in instance ? instance.invalidReason : undefined;
}

describe('tomlNestingWithinLimit', () => {
  it('counts containers below the root table, which is depth 0', () => {
    expect(TOML_NESTING_LIMIT).toBe(64);
    expect(tomlNestingWithinLimit(nestedArrays(64))).toBe(true);
    expect(tomlNestingWithinLimit(nestedArrays(65))).toBe(false);
  });

  it('counts null-prototype tables as containers', () => {
    const atLimit = Object.assign(Object.create(null), nestedArrays(TOML_NESTING_LIMIT));
    const pastLimit = Object.assign(Object.create(null), nestedArrays(TOML_NESTING_LIMIT + 1));
    expect(tomlNestingWithinLimit(atLimit)).toBe(true);
    expect(tomlNestingWithinLimit(pastLimit)).toBe(false);
  });

  it('treats a TOML date as a scalar, not a container', () => {
    expect(tomlNestingWithinLimit(tableWithScalar(new Date(0), TOML_NESTING_LIMIT))).toBe(true);
    expect(tomlNestingWithinLimit(tableWithScalar(new Date(0), TOML_NESTING_LIMIT + 1))).toBe(
      false
    );
  });

  it.each([
    ['1979-05-27T00:32:00.123456789-07:00', 'Temporal.Instant'],
    ['1979-05-27T07:32:00.123456789', 'Temporal.PlainDateTime'],
    ['1979-05-27', 'Temporal.PlainDate'],
    ['07:32:00.123456789', 'Temporal.PlainTime'],
  ])('treats Bun TOML %s as a scalar at the limit', (literal, tag) => {
    const value = Reflect.get(Bun.TOML.parse(`value = ${literal}`), 'value');
    expect(Object.prototype.toString.call(value)).toBe(`[object ${tag}]`);
    expect(tomlNestingWithinLimit(tableWithScalar(value, TOML_NESTING_LIMIT))).toBe(true);
    expect(tomlNestingWithinLimit(tableWithScalar(value, TOML_NESTING_LIMIT + 1))).toBe(false);
  });

  it('walks half a million levels without exhausting the stack', () => {
    let value: Record<string, unknown> = {};
    for (let level = 0; level < 500_000; level += 1) value = { k: value };
    expect(tomlNestingWithinLimit(value)).toBe(false);
  });
});

describe('TOML metadata nesting', () => {
  it.each([
    '1979-05-27T00:32:00.123456789-07:00',
    '1979-05-27T07:32:00.123456789',
    '1979-05-27',
    '07:32:00.123456789',
  ])('reads a TOML resource containing %s as valid', async (literal) => {
    expect(await settingsVerdict(`updated = ${literal}\n`)).toBeUndefined();
    const key = `${'a.'.repeat(TOML_NESTING_LIMIT)}updated`;
    expect(await settingsVerdict(`${key} = ${literal}\n`)).toBeUndefined();
  });

  it.each(['[agent', 'updated =', 'updated = 1\nupdated = 2'])(
    'reports malformed TOML %s as invalid-metadata',
    async (text) => {
      expect(await settingsVerdict(text)).toBe('invalid-metadata');
    }
  );

  it('rejects an impossible calendar date as invalid-metadata', async () => {
    expect(await settingsVerdict('updated = 1979-02-30')).toBe('invalid-metadata');
    expect(await settingsVerdict('updated = 2000-02-29')).toBeUndefined();
  });

  it('reports a document nested past the limit as invalid-metadata', async () => {
    const deep = `a = ${'['.repeat(65)}${']'.repeat(65)}\n`;
    expect(await settingsVerdict(deep)).toBe('invalid-metadata');
    const atLimit = `a = ${'['.repeat(64)}${']'.repeat(64)}\n`;
    expect(await settingsVerdict(atLimit)).toBeUndefined();
  });
});
