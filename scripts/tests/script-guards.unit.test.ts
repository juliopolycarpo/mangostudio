import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import {
  describeReceived,
  invalidValue,
  isJsonRecord,
  MAX_RECEIVED_LENGTH,
  requireJsonRecord,
  requirePositiveSafeInteger,
  sha256OfBytes,
  sha256OfFile,
  toPosixPath,
} from '../lib/script-guards';

const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function messageOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return error instanceof Error ? error.message : `non-Error thrown: ${String(error)}`;
  }
  return 'did not throw';
}

describe('describeReceived', () => {
  test.each([
    [undefined, 'undefined'],
    [null, 'null'],
    ['text', '"text"'],
    [42, '42'],
    [-0.5, '-0.5'],
    [Number.NaN, 'NaN'],
    [Number.POSITIVE_INFINITY, 'Infinity'],
    [10n, '10n'],
    [true, 'true'],
    [Symbol('tag'), 'Symbol(tag)'],
    [[1, 'a'], '[1,"a"]'],
    [{ id: 1 }, '{"id":1}'],
  ])('renders %p as %s', (value, expected) => {
    expect(describeReceived(value)).toBe(expected);
  });

  test('names a function instead of dropping it', () => {
    expect(describeReceived(function namedProbe() {})).toBe('[function namedProbe]');
    expect(describeReceived(() => {})).toBe('[function anonymous]');
  });

  test('keeps bigints and non-finite numbers readable inside an object', () => {
    expect(describeReceived({ size: 5n, ratio: Number.NaN })).toBe('{"size":"5n","ratio":"NaN"}');
  });

  test('marks a cycle and keeps the rest of the payload', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;
    expect(describeReceived(cyclic)).toBe('{"name":"loop","self":"[Circular]"}');
  });

  test('does not mistake a repeated, non-cyclic reference for a cycle', () => {
    const shared = { id: 1 };
    expect(describeReceived({ left: shared, right: shared })).toBe(
      '{"left":{"id":1},"right":{"id":1}}'
    );
  });

  test('names the kind of a value whose serialization throws', () => {
    const throwing = {
      toJSON(): never {
        throw new Error('toJSON exploded');
      },
    };
    expect(describeReceived(throwing)).toBe('[unserializable object]');
  });

  test('keeps a payload at the limit whole and cuts one character past it', () => {
    const atLimit = 'x'.repeat(MAX_RECEIVED_LENGTH - 2); // the two quotes bring it to the limit
    expect(describeReceived(atLimit)).toBe(`"${atLimit}"`);

    const pastLimit = 'x'.repeat(MAX_RECEIVED_LENGTH - 1);
    const rendered = describeReceived(pastLimit);
    expect(rendered).toBe(
      `"${'x'.repeat(MAX_RECEIVED_LENGTH - 1)}... (${MAX_RECEIVED_LENGTH + 1} characters in total)`
    );
  });

  test('truncates a very large payload and reports its full length', () => {
    const rendered = describeReceived({
      items: Array.from({ length: 5_000 }, (_, index) => index),
    });
    expect(rendered.startsWith('{"items":[0,1,2,')).toBe(true);
    expect(rendered).toMatch(/\.\.\. \(\d+ characters in total\)$/);
    expect(rendered.length).toBeLessThan(MAX_RECEIVED_LENGTH + 60);
  });
});

describe('invalidValue', () => {
  test('names the label, the expected shape and the received value', () => {
    const error = invalidValue('CI run', 'object', null);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Invalid CI run: expected object; received null');
  });
});

describe('isJsonRecord', () => {
  test.each([[{}], [{ id: 1 }], [Object.create(null)]])('accepts %p', (value) => {
    expect(isJsonRecord(value)).toBe(true);
  });

  test.each([[null], [undefined], [[]], [[{}]], ['text'], [1], [true], [() => {}]])(
    'rejects %p',
    (value) => {
      expect(isJsonRecord(value)).toBe(false);
    }
  );

  test('narrows an unknown value to a record', () => {
    const value: unknown = { id: 7 };
    if (!isJsonRecord(value)) throw new Error('expected a record');
    expect(value.id).toBe(7);
  });
});

describe('requireJsonRecord', () => {
  test('returns the same object it was given', () => {
    const value = { id: 1 };
    expect(requireJsonRecord(value, 'release')).toBe(value);
  });

  test.each([
    [null, 'null'],
    [undefined, 'undefined'],
    [[], '[]'],
    [[1], '[1]'],
    ['release', '"release"'],
    [7, '7'],
    [7n, '7n'],
    [Number.NaN, 'NaN'],
    [() => {}, '[function anonymous]'],
  ])('rejects %p and names the value', (value, rendered) => {
    expect(messageOf(() => requireJsonRecord(value, 'release asset'))).toBe(
      `Invalid release asset: expected object; received ${rendered}`
    );
  });

  test('rejects a cyclic array without throwing from the renderer', () => {
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(messageOf(() => requireJsonRecord(cyclic, 'asset list'))).toBe(
      'Invalid asset list: expected object; received ["[Circular]"]'
    );
  });

  test('truncates a very large rejected value', () => {
    const message = messageOf(() => requireJsonRecord('y'.repeat(10_000), 'payload'));
    expect(message.startsWith('Invalid payload: expected object; received "yyy')).toBe(true);
    expect(message).toEndWith('... (10002 characters in total)');
    expect(message.length).toBeLessThan(MAX_RECEIVED_LENGTH + 120);
  });
});

describe('requirePositiveSafeInteger', () => {
  test.each([[1], [2], [Number.MAX_SAFE_INTEGER]])('returns %p', (value) => {
    expect(requirePositiveSafeInteger(value, 'run id')).toBe(value);
  });

  test.each([
    [0, '0'],
    [-3, '-3'],
    [1.5, '1.5'],
    [Number.NaN, 'NaN'],
    [Number.POSITIVE_INFINITY, 'Infinity'],
    [Number.MAX_SAFE_INTEGER + 1, String(Number.MAX_SAFE_INTEGER + 1)],
    ['7', '"7"'],
    [7n, '7n'],
    [null, 'null'],
    [undefined, 'undefined'],
    [{ id: 7 }, '{"id":7}'],
    [[7], '[7]'],
  ])('rejects %p and names the value', (value, rendered) => {
    expect(messageOf(() => requirePositiveSafeInteger(value, 'run id'))).toBe(
      `Invalid run id: expected positive safe integer; received ${rendered}`
    );
  });
});

describe('sha256OfBytes', () => {
  test('hashes bytes, strings and an empty input to lowercase hex', () => {
    expect(sha256OfBytes(new TextEncoder().encode('abc'))).toBe(ABC_SHA256);
    expect(sha256OfBytes(Buffer.from('abc'))).toBe(ABC_SHA256);
    expect(sha256OfBytes('abc')).toBe(ABC_SHA256);
    expect(sha256OfBytes(new Uint8Array())).toBe(EMPTY_SHA256);
  });
});

describe('sha256OfFile', () => {
  test('hashes file contents with SHA-256', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mangostudio-script-guards-'));
    tempDirs.push(directory);
    const filePath = join(directory, 'asset.tar.gz');
    writeFileSync(filePath, 'release asset');

    expect(sha256OfFile(filePath)).toBe(
      'e6abe9df7db8513616674b02b5edb26c37bf3b2f81daeec1e3c6fc8c9a802850'
    );
  });

  test('matches the bytes digest of the same content', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mangostudio-script-guards-'));
    tempDirs.push(directory);
    const filePath = join(directory, 'abc.txt');
    writeFileSync(filePath, 'abc');

    expect(sha256OfFile(filePath)).toBe(ABC_SHA256);
  });

  test('fails with the missing path when the file is absent', () => {
    const missing = join(tmpdir(), 'mangostudio-script-guards-missing', 'absent.bin');
    expect(messageOf(() => sha256OfFile(missing))).toContain(missing);
  });
});

describe('toPosixPath', () => {
  test('joins segments with forward slashes', () => {
    expect(toPosixPath(['apps', 'api', 'src'].join(sep))).toBe('apps/api/src');
  });

  test('leaves a path without separators and an empty path unchanged', () => {
    expect(toPosixPath('package.json')).toBe('package.json');
    expect(toPosixPath('')).toBe('');
  });
});
