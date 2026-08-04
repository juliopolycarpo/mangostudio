import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { loadRuntimeReleaseBytes } from '../../../../src/modules/environments/domain/runtime-release-fetch';
import { resolveRuntimeRelease } from '../../../../src/modules/environments/domain/runtime-release-resolution';

describe('resolveRuntimeRelease', () => {
  it('keeps stable tag and asset identity exact', () => {
    expect(resolveRuntimeRelease('1.2.3', 'linux-x64')).toEqual({
      channel: 'stable',
      tagVersion: '1.2.3',
      assetVersion: '1.2.3',
      runtimeAssetName: 'mangostudio-runtime-1.2.3-linux-x64',
    });
  });

  it('maps a sha-stamped canary build onto the rolling tag and asset', () => {
    expect(resolveRuntimeRelease('1.2.3-canary.abcdef0', 'darwin-arm64')).toEqual({
      channel: 'canary',
      tagVersion: '1.2.3-canary',
      assetVersion: '1.2.3-canary',
      runtimeAssetName: 'mangostudio-runtime-1.2.3-canary-darwin-arm64',
    });
  });

  it('keeps an unrecognized prerelease on its exact stable release identity', () => {
    expect(resolveRuntimeRelease('1.2.3-rc.1', 'linux-x64')).toEqual({
      channel: 'stable',
      tagVersion: '1.2.3-rc.1',
      assetVersion: '1.2.3-rc.1',
      runtimeAssetName: 'mangostudio-runtime-1.2.3-rc.1-linux-x64',
    });
  });

  it('fetches canary checksums and bytes from the rolling release identity', async () => {
    const bytes = new TextEncoder().encode('canary-runtime');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const calls: string[] = [];
    const asset = 'mangostudio-runtime-1.2.3-canary-linux-x64';

    const loaded = await loadRuntimeReleaseBytes('linux-x64', {
      version: '1.2.3-canary.abcdef0',
      fetch: ((input: string | URL | Request) => {
        const url = String(input);
        calls.push(url);
        return Promise.resolve(
          url.endsWith('/SHA256SUMS') ? new Response(`${hash}  ${asset}\n`) : new Response(bytes)
        );
      }) as unknown as typeof fetch,
      cacheDir: () => '/unused',
      readBytes: () => Promise.resolve(null),
      writeCache: () => Promise.resolve(),
    });

    expect(loaded).toMatchObject({ fromArchive: false, digest: `sha256:${hash}` });
    expect(calls).toEqual([
      'https://github.com/juliopolycarpo/mangostudio/releases/download/v1.2.3-canary/SHA256SUMS',
      `https://github.com/juliopolycarpo/mangostudio/releases/download/v1.2.3-canary/${asset}`,
    ]);
  });
});
