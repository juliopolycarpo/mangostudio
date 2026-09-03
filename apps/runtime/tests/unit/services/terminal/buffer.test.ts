import { describe, expect, it } from 'bun:test';
import { ByteRingBuffer } from '../../../../src/services/terminal/buffer';

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function text(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}

describe('ByteRingBuffer', () => {
  it('refuses a non-positive or fractional capacity', () => {
    expect(() => new ByteRingBuffer(0)).toThrow(/positive integer/);
    expect(() => new ByteRingBuffer(-1)).toThrow(/positive integer/);
    expect(() => new ByteRingBuffer(1.5)).toThrow(/positive integer/);
  });

  it('keeps everything pushed while under capacity', () => {
    const buffer = new ByteRingBuffer(16);
    buffer.push(bytes('hello '));
    buffer.push(bytes('world'));

    expect(buffer.byteLength).toBe(11);
    expect(text(buffer.snapshot())).toBe('hello world');
  });

  it('drops the oldest bytes past capacity, keeping the tail', () => {
    const buffer = new ByteRingBuffer(5);
    buffer.push(bytes('abcdefgh'));

    expect(buffer.byteLength).toBe(5);
    expect(text(buffer.snapshot())).toBe('defgh');
  });

  it('drops across chunk boundaries, splitting a surviving chunk', () => {
    const buffer = new ByteRingBuffer(5);
    buffer.push(bytes('abc'));
    buffer.push(bytes('de'));
    buffer.push(bytes('fgh'));

    // capacity 5, 8 pushed total: only "defgh" survives, "fgh" spans the
    // boundary of what was kept from the second chunk.
    expect(text(buffer.snapshot())).toBe('defgh');
  });

  it('take() drains from the front and shrinks the buffer', () => {
    const buffer = new ByteRingBuffer(16);
    buffer.push(bytes('abcdef'));

    expect(text(buffer.take(3))).toBe('abc');
    expect(buffer.byteLength).toBe(3);
    expect(text(buffer.take(10))).toBe('def');
    expect(buffer.byteLength).toBe(0);
  });

  it('take() across several chunks returns them joined, oldest first', () => {
    const buffer = new ByteRingBuffer(16);
    buffer.push(bytes('ab'));
    buffer.push(bytes('cd'));
    buffer.push(bytes('ef'));

    expect(text(buffer.take(5))).toBe('abcde');
    expect(text(buffer.take(5))).toBe('f');
  });

  it('take() on an empty buffer returns nothing', () => {
    const buffer = new ByteRingBuffer(4);
    expect(buffer.take(4).byteLength).toBe(0);
  });

  it('accumulates dropped bytes across an overflow episode into one count', () => {
    const buffer = new ByteRingBuffer(4);
    buffer.push(bytes('ab')); // fits, nothing dropped
    buffer.push(bytes('cd')); // fits exactly, nothing dropped
    buffer.push(bytes('ef')); // overflow: drops "ab"
    buffer.push(bytes('gh')); // overflow: drops "cd"

    // One accumulated count for the whole episode, not one report per push.
    expect(buffer.takeDroppedBytes()).toBe(4);
    // Reading again without a new drop reports nothing: a marker fires once.
    expect(buffer.takeDroppedBytes()).toBe(0);
    expect(text(buffer.snapshot())).toBe('efgh');
  });

  it('clear() empties the buffer and discards any uncollected drop count', () => {
    const buffer = new ByteRingBuffer(4);
    buffer.push(bytes('abcdef')); // drops "ab"

    buffer.clear();

    expect(buffer.byteLength).toBe(0);
    expect(buffer.snapshot().byteLength).toBe(0);
    expect(buffer.takeDroppedBytes()).toBe(0);
  });
});
