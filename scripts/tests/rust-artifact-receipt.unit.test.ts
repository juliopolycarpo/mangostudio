import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ArtifactInspector,
  attributeRustArtifact,
  identifyRustArtifactVersion,
  inspectRustArtifact,
  preserveRustArtifact,
  type RustArtifactReceipt,
} from '../lib/rust-artifact-receipt';

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
class FakeArtifactInspector implements ArtifactInspector {
  readonly commands: string[][] = [];
  readonly hashValues: string[] = ['a'.repeat(64), 'b'.repeat(64), 'a'.repeat(64)];
  capture(_label: string, command: readonly string[]): Promise<string> {
    this.commands.push([...command]);
    return Promise.resolve(command[0] === 'size' ? '.text 4 0\n' : 'ELF fixture');
  }
  hash(): Promise<string> {
    return Promise.resolve(this.hashValues.shift() as string);
  }
}
async function fixture(): Promise<{ root: string; binary: string }> {
  const root = await mkdtemp(join(tmpdir(), 'rust-artifact-test-'));
  scratch.push(root);
  const binary = join(root, 'binary');
  await Bun.write(binary, 'test');
  return { root, binary };
}
class FakeArtifactVersionCapture {
  readonly commands: string[][] = [];
  constructor(private readonly result: string) {}
  readonly capture = (command: readonly string[]): Promise<string> => {
    this.commands.push([...command]);
    return Promise.resolve(this.result);
  };
}
describe('Rust artifact identity', () => {
  it('identifies the downloader from sealed metadata without executing or downloading anything', async () => {
    const fake = new FakeArtifactVersionCapture('unrelated downloaded hub');
    const identity = await identifyRustArtifactVersion(
      'mangostudio',
      '[package]\nname="mangostudio"\nversion="0.1.1"',
      '/launcher',
      '0.1.1',
      fake.capture
    );
    expect(identity).toMatchObject({
      version: '0.1.1',
      valid: true,
      executed: false,
      source: 'sealed launcher Cargo package metadata',
    });
    expect(fake.commands).toEqual([]);
  });
  it('checks the runtime stamp against its own version output', async () => {
    const manifest = '[package]\nname="mangostudio-runtime"\nversion="0.1.1"';
    const fake = new FakeArtifactVersionCapture('0.1.1-bench.1\n');
    expect(
      (
        await identifyRustArtifactVersion(
          'mangostudio-runtime',
          manifest,
          '/runtime',
          '0.1.1-bench.1',
          fake.capture
        )
      ).valid
    ).toBe(true);
    expect(fake.commands).toEqual([['/runtime', '--version']]);
    expect(
      (
        await identifyRustArtifactVersion(
          'mangostudio-runtime',
          manifest,
          '/runtime',
          '0.1.1',
          fake.capture
        )
      ).valid
    ).toBe(false);
    await expect(
      identifyRustArtifactVersion('unknown', manifest, '/runtime', '0.1.1', fake.capture)
    ).rejects.toThrow('expected unknown');
  });

  it('extracts text into separate output while verifying the input remains unchanged', async () => {
    const { root, binary } = await fixture();
    const fake = new FakeArtifactInspector();
    const receipt = await inspectRustArtifact(binary, join(root, 'inspect'), fake);
    expect(receipt.bytes).toBe(4);
    expect(receipt.sha256).toBe('a'.repeat(64));
    expect(receipt.textSha256).toBe('b'.repeat(64));
    const command = fake.commands[2];
    expect(command[3]).toBe(binary);
    expect(command[4]).not.toBe(binary);
  });
  it('rejects an artifact changed while it was inspected', async () => {
    const { root, binary } = await fixture();
    const fake = new FakeArtifactInspector();
    fake.hashValues[2] = 'c'.repeat(64);
    await expect(inspectRustArtifact(binary, root, fake)).rejects.toThrow(
      'expected unchanged SHA-256'
    );
  });
  it('preserves an identical artifact', async () => {
    const { root, binary } = await fixture();
    const result = await preserveRustArtifact(binary, join(root, 'preserved'));
    expect(result.bytes).toBe(4);
    expect(result.sha256).toHaveLength(64);
    expect(await Bun.file(result.path).text()).toBe('test');
  });
  it('keeps mismatched attribution explicitly unqualified and validates bloat shape', () => {
    const base: RustArtifactReceipt = {
      path: 'a',
      bytes: 4,
      sha256: 'a'.repeat(64),
      textSha256: 'b'.repeat(64),
      sections: [{ name: '.text', bytes: 4, address: '0' }],
      readelf: '',
    };
    expect(
      attributeRustArtifact(base, base, '{"crates":[],"file-size":4,"text-section-size":4}')
        .qualified
    ).toBe(true);
    expect(
      attributeRustArtifact(
        base,
        { ...base, textSha256: 'c'.repeat(64) },
        '{"crates":[],"file-size":4,"text-section-size":4}'
      ).qualified
    ).toBe(false);
    expect(() => attributeRustArtifact(base, base, '{}')).toThrow(
      'expected JSON object with crates array'
    );
    expect(() =>
      attributeRustArtifact(base, base, '{"crates":[],"file-size":99,"text-section-size":4}')
    ).toThrow('matching the inspected symbol artifact');
    expect(() =>
      attributeRustArtifact(
        base,
        base,
        '{"crates":[{"name":"bad","size":-1}],"file-size":4,"text-section-size":4}'
      )
    ).toThrow('nonnegative safe integer size');
  });
});
