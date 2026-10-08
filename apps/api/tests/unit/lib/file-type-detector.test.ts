import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { type DetectedFileType, detectFileType } from '../../../src/lib/file-type-detector';
import fixtures from '../../support/fixtures/file-type/fixtures.json';

const FIXTURE_ROOT = join(import.meta.dir, '../../support/fixtures/file-type');

class FakeFileTypeDetector {
  readonly calls: Array<Uint8Array | ArrayBuffer> = [];

  constructor(private readonly result: DetectedFileType | undefined) {}

  detect(bytes: Uint8Array | ArrayBuffer): Promise<DetectedFileType | undefined> {
    this.calls.push(bytes);
    return Promise.resolve(this.result);
  }
}

class FailingFileTypeDetector {
  readonly error = new Error('File-type detector failed while reading the supplied bytes.');

  detect(): Promise<never> {
    return Promise.reject(this.error);
  }
}

describe('detectFileType', () => {
  it.each(fixtures.cases)('detects the real $file fixture as $mime', async (fixture) => {
    const buffer = await Bun.file(join(FIXTURE_ROOT, fixture.file)).arrayBuffer();
    expect(createHash('sha256').update(new Uint8Array(buffer)).digest('hex')).toBe(fixture.sha256);
    const expected = { mime: fixture.mime, ext: fixture.ext };
    expect(await detectFileType(buffer)).toEqual(expected);
    expect(await detectFileType(new Uint8Array(buffer))).toEqual(expected);
  });

  it('returns null for unrecognized bytes and empty inputs', async () => {
    expect(await detectFileType(new Uint8Array([0x00, 0x01, 0x02, 0x03]))).toBeNull();
    expect(await detectFileType(new TextEncoder().encode('unrecognized file bytes'))).toBeNull();
    expect(await detectFileType(new Uint8Array())).toBeNull();
    expect(await detectFileType(new ArrayBuffer(0))).toBeNull();
  });

  it('keeps a Uint8Array view within its byte offset and length', async () => {
    const buffer = await Bun.file(join(FIXTURE_ROOT, 'fixture.jpg')).arrayBuffer();
    const padded = new Uint8Array(buffer.byteLength + 4);
    padded.set(new Uint8Array(buffer), 2);
    expect(await detectFileType(padded.subarray(2, -2))).toEqual({
      mime: 'image/jpeg',
      ext: 'jpg',
    });
  });

  it('passes the original bytes to the injected detector and exposes only mime and ext', async () => {
    const bytes = new Uint8Array([0x01, 0x02]);
    const vendorResult = { mime: 'application/example', ext: 'example', vendorMetadata: true };
    const fake = new FakeFileTypeDetector(vendorResult);
    expect(await detectFileType(bytes, fake.detect.bind(fake))).toEqual({
      mime: 'application/example',
      ext: 'example',
    });
    expect(fake.calls).toEqual([bytes]);
    expect(fake.calls[0]).toBe(bytes);
  });

  it('normalizes an injected detector miss to null', async () => {
    const fake = new FakeFileTypeDetector(undefined);
    expect(await detectFileType(new ArrayBuffer(4), fake.detect.bind(fake))).toBeNull();
    expect(fake.calls).toHaveLength(1);
  });

  it('propagates the named fake detector failure without changing the error', async () => {
    const fake = new FailingFileTypeDetector();
    await expect(detectFileType(new Uint8Array([0x01]), fake.detect.bind(fake))).rejects.toBe(
      fake.error
    );
  });
});
