import { describe, expect, it } from 'bun:test';
import { parseCursorPosition } from '../../../../../src/modules/messages/domain/cursor-position';
import {
  compareGalleryOrder,
  decodeGalleryCursor,
  encodeGalleryCursor,
  type GalleryCursor,
  InvalidGalleryCursorError,
  tiedRowidCeiling,
} from '../../../../../src/modules/messages/domain/gallery-cursor';

const TS = 1_700_000_000_000;

function decodeError(value: string): Error | null {
  try {
    decodeGalleryCursor(value);
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

describe('parseCursorPosition', () => {
  it('reads timestamp and rowid', () => {
    expect(parseCursorPosition(`${TS}:42`)).toEqual({ timestamp: TS, rowid: 42 });
  });

  it('reads a bare timestamp as a legacy position without a rowid', () => {
    expect(parseCursorPosition(String(TS))).toEqual({ timestamp: TS, rowid: null });
  });

  it.each([
    ['a fractional timestamp', '1.5:2', { timestamp: 1.5, rowid: 2 }],
    ['a negative timestamp', '-5:2', { timestamp: -5, rowid: 2 }],
    ['a timestamp beyond the safe integer range', '1e+21:2', { timestamp: 1e21, rowid: 2 }],
    ['a bare negative timestamp', '-1', { timestamp: -1, rowid: null }],
  ])('reads %s the way Number#toString prints it', (_label, value, expected) => {
    expect(parseCursorPosition(value)).toEqual(expected);
  });

  it.each([
    '',
    'abc',
    '1:2:3',
    '1:',
    ':1',
    '1e999',
    '1e999:1',
    '1:-1',
    '1:1.5',
    '1:9999999999999999',
  ])('returns null for %p', (value) => {
    expect(parseCursorPosition(value)).toBeNull();
  });
});

describe('gallery cursor codec', () => {
  it.each(['artifact', 'message'] as const)('round-trips a %s position', (source) => {
    const cursor: GalleryCursor = { createdAt: TS, source, rowid: 42 };

    expect(encodeGalleryCursor(cursor)).toBe(`${source}:${TS}:42`);
    expect(decodeGalleryCursor(encodeGalleryCursor(cursor))).toEqual(cursor);
  });

  it.each([
    ['a fractional timestamp', 1.5],
    ['a negative timestamp', -5],
    ['a timestamp beyond the safe integer range', 1e21],
    ['a tiny fractional timestamp', 1.5e-7],
  ])('round-trips %s that can be stored', (_label, createdAt) => {
    const cursor: GalleryCursor = { createdAt, source: 'artifact', rowid: 3 };

    expect(decodeGalleryCursor(encodeGalleryCursor(cursor))).toEqual(cursor);
  });

  it('reads a bare numeric timestamp as after every image of it, never before', () => {
    const cursor = decodeGalleryCursor(String(TS));

    expect(cursor).toEqual({ createdAt: TS, source: 'message', rowid: 0 });
    expect(tiedRowidCeiling('artifact', cursor)).toBe(0);
    expect(tiedRowidCeiling('message', cursor)).toBe(0);
  });

  it.each([
    ['non-numeric text', 'not-a-cursor'],
    ['the transcript shape without a source', `${TS}:42`],
    ['an unknown source', `video:${TS}:42`],
    ['a source without a rowid', `artifact:${TS}`],
    ['a negative rowid', `artifact:${TS}:-1`],
    ['a timestamp too large to be finite', 'message:1e999:1'],
    ['a bare timestamp too large to be finite', '1e999'],
    ['a rowid beyond the safe integer range', 'message:1:9999999999999999'],
    ['a fractional rowid', 'message:1:1.5'],
    ['an empty value after the source', 'artifact:'],
  ])('rejects %s with the value and the expected shape', (_label, value) => {
    const error = decodeError(value);

    expect(error?.name ?? 'no error thrown').toBe(InvalidGalleryCursorError.name);
    expect(error?.message).toContain(JSON.stringify(value));
    expect(error?.message).toContain('expected shape: <artifact|message>:<createdAt>:<rowid>');
  });
});

describe('gallery order', () => {
  const at = (
    createdAt: number,
    source: GalleryCursor['source'],
    rowid: number
  ): GalleryCursor => ({
    createdAt,
    source,
    rowid,
  });

  it('sorts newest first, then artifact before message, then higher rowid first', () => {
    const shuffled = [
      at(TS, 'message', 9),
      at(TS - 1, 'artifact', 99),
      at(TS, 'artifact', 1),
      at(TS, 'message', 10),
      at(TS, 'artifact', 2),
      at(TS + 1, 'message', 1),
    ];

    expect([...shuffled].sort(compareGalleryOrder)).toEqual([
      at(TS + 1, 'message', 1),
      at(TS, 'artifact', 2),
      at(TS, 'artifact', 1),
      at(TS, 'message', 10),
      at(TS, 'message', 9),
      at(TS - 1, 'artifact', 99),
    ]);
  });

  it('agrees with tiedRowidCeiling about which tied rows come after a cursor', () => {
    const rows = [
      at(TS, 'artifact', 1),
      at(TS, 'artifact', 2),
      at(TS, 'message', 1),
      at(TS, 'message', 2),
    ];

    for (const cursor of rows) {
      const afterByOrder = rows.filter((row) => compareGalleryOrder(row, cursor) > 0);
      const afterByCeiling = rows.filter((row) => row.rowid < tiedRowidCeiling(row.source, cursor));
      expect(afterByCeiling).toEqual(afterByOrder);
    }
  });
});
