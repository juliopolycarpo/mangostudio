import { describe, expect, it } from 'bun:test';
import {
  ContainerRuntimeSourceError,
  resolveContainerRuntimeBinary,
} from '../../../../src/modules/environments/domain/container-runtime-source';

const MANGO_HOME = '/home/j/.mango';
const BASE_DIR = '/repo';
const BYTES = new Uint8Array([0x7f, 0x45, 0x4c, 0x46]);

function deps(overrides: Record<string, unknown> = {}) {
  return {
    version: '0.1.1',
    mangoHome: MANGO_HOME,
    baseDir: BASE_DIR,
    loadBytes: () => Promise.resolve({ bytes: BYTES, fromArchive: false, digest: 'sha256:abc' }),
    fileExists: () => Promise.resolve(true),
    writeBinary: () => Promise.resolve(),
    ...overrides,
  } as never;
}

describe('resolveContainerRuntimeBinary in a source checkout', () => {
  it('mounts the build the checkout made for that platform', async () => {
    const path = await resolveContainerRuntimeBinary('linux-x64-musl', deps({ version: 'dev' }));

    expect(path).toBe('/repo/.mango/out/linux-x64-musl/mangostudio-runtime');
  });

  it('never asks a release for a version no tag will ever carry', async () => {
    let fetched = false;
    await resolveContainerRuntimeBinary(
      'linux-x64',
      deps({
        version: 'dev',
        loadBytes: () => {
          fetched = true;
          return Promise.resolve({ bytes: BYTES, fromArchive: false, digest: 'sha256:abc' });
        },
      })
    );

    expect(fetched).toBe(false);
  });

  it('names the command that produces a build there is not one of', async () => {
    const attempt = resolveContainerRuntimeBinary(
      'linux-arm64',
      deps({ version: 'dev', fileExists: () => Promise.resolve(false) })
    );

    await expect(attempt).rejects.toBeInstanceOf(ContainerRuntimeSourceError);
    await expect(attempt).rejects.toThrow(/--target=bun-linux-arm64/);
  });
});

describe('resolveContainerRuntimeBinary from a release', () => {
  it('writes the verified bytes into the documented cache and returns that path', async () => {
    const written: { path?: string; bytes?: Uint8Array } = {};
    const path = await resolveContainerRuntimeBinary(
      'linux-x64',
      deps({
        writeBinary: (target: string, bytes: Uint8Array) => {
          written.path = target;
          written.bytes = bytes;
          return Promise.resolve();
        },
      })
    );

    expect(path).toBe('/home/j/.mango/runtime-cache/0.1.1/mangostudio-runtime-0.1.1-linux-x64');
    expect(written.path).toBe(path);
    expect(written.bytes).toEqual(BYTES);
  });

  it('resolves a canary hub onto the rolling asset name', async () => {
    const path = await resolveContainerRuntimeBinary(
      'linux-x64',
      deps({ version: '0.1.1-canary.gabc1234' })
    );

    // The cache directory is the hub's own version; the asset carries the
    // rolling name, which is what the release actually published.
    expect(path).toBe(
      '/home/j/.mango/runtime-cache/0.1.1-canary.gabc1234/mangostudio-runtime-0.1.1-canary-linux-x64'
    );
  });

  it('refuses an archive-only release rather than growing a second unpack path', async () => {
    const attempt = resolveContainerRuntimeBinary(
      'linux-arm64-musl',
      deps({
        loadBytes: () => Promise.resolve({ bytes: BYTES, fromArchive: true, digest: 'sha256:abc' }),
      })
    );

    await expect(attempt).rejects.toThrow(/publishes no standalone linux-arm64-musl runtime/);
  });

  it('reports a failed fetch as a source problem, keeping the cause', async () => {
    const attempt = resolveContainerRuntimeBinary(
      'linux-x64',
      deps({ loadBytes: () => Promise.reject(new Error('checksum mismatch')) })
    );

    await expect(attempt).rejects.toThrow(/checksum mismatch/);
  });
});
