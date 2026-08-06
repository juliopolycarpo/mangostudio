import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  loadRuntimeReleaseBytes,
  pinnedRuntimeDigest,
  runtimeDigestSidecarPath,
} from '../../../../src/modules/environments/domain/runtime-release-fetch';
import { resolveRuntimeRelease } from '../../../../src/modules/environments/domain/runtime-release-resolution';

describe('resolveRuntimeRelease', () => {
  it('keeps stable tag and asset identity exact', () => {
    expect(resolveRuntimeRelease('1.2.3', 'linux-x64')).toEqual({
      channel: 'stable',
      tagVersion: '1.2.3',
      assetVersion: '1.2.3',
      runtimeAssetName: 'mangostudio-runtime-1.2.3-linux-x64',
      rolling: false,
    });
  });

  it('maps a sha-stamped canary build onto the rolling tag and asset', () => {
    expect(resolveRuntimeRelease('1.2.3-canary.abcdef0', 'darwin-arm64')).toEqual({
      channel: 'canary',
      tagVersion: '1.2.3-canary',
      assetVersion: '1.2.3-canary',
      runtimeAssetName: 'mangostudio-runtime-1.2.3-canary-darwin-arm64',
      rolling: true,
    });
  });

  // `canaryReleaseVersion` prefixes a short sha that is all digits with a
  // leading zero, because that is an illegal semver numeric identifier. Reading
  // it as stable would resolve a tag no release ever published.
  it('maps a git-describe style canary sha onto the same rolling identity', () => {
    expect(resolveRuntimeRelease('1.2.3-canary.g0123456', 'linux-x64')).toEqual({
      channel: 'canary',
      tagVersion: '1.2.3-canary',
      assetVersion: '1.2.3-canary',
      runtimeAssetName: 'mangostudio-runtime-1.2.3-canary-linux-x64',
      rolling: true,
    });
  });

  it('keeps an unrecognized prerelease on its exact stable release identity', () => {
    expect(resolveRuntimeRelease('1.2.3-rc.1', 'linux-x64')).toEqual({
      channel: 'stable',
      tagVersion: '1.2.3-rc.1',
      assetVersion: '1.2.3-rc.1',
      runtimeAssetName: 'mangostudio-runtime-1.2.3-rc.1-linux-x64',
      rolling: false,
    });
  });

  // `releaseRawRuntimeBinaryFileName` writes `.exe` for the two Windows
  // targets. Resolving a Windows platform to an extensionless name asks a
  // release for an asset it never published — latent until something asks
  // about a Windows target, which the copyable install one-liner does.
  it.each([
    ['windows-x64', 'mangostudio-runtime-1.2.3-windows-x64.exe'],
    ['windows-arm64', 'mangostudio-runtime-1.2.3-windows-arm64.exe'],
  ])('keeps the published .exe suffix for %s', (platformId, assetName) => {
    expect(resolveRuntimeRelease('1.2.3', platformId).runtimeAssetName).toBe(assetName);
  });

  it('keeps the .exe suffix on the rolling canary asset too', () => {
    expect(resolveRuntimeRelease('1.2.3-canary.abcdef0', 'windows-x64').runtimeAssetName).toBe(
      'mangostudio-runtime-1.2.3-canary-windows-x64.exe'
    );
  });

  it('fetches canary checksums and bytes from the rolling release identity', async () => {
    const bytes = new TextEncoder().encode('canary-runtime');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const calls: string[] = [];
    let resolved = 0;
    const asset = 'mangostudio-runtime-1.2.3-canary-linux-x64';

    const loaded = await loadRuntimeReleaseBytes('linux-x64', {
      version: '1.2.3-canary.abcdef0',
      fetch: ((input: string | URL | Request) => {
        const url = String(input);
        calls.push(url);
        // A rolling release cut before the manifest existed publishes none;
        // provisioning has to keep working against those.
        if (url.endsWith('/canary-manifest.json')) {
          return Promise.resolve(new Response('not found', { status: 404 }));
        }
        return Promise.resolve(
          url.endsWith('/SHA256SUMS') ? new Response(`${hash}  ${asset}\n`) : new Response(bytes)
        );
      }) as unknown as typeof fetch,
      resolveHostname: () => {
        resolved += 1;
        return Promise.resolve([{ address: '140.82.112.4', family: 4 as const }]);
      },
      cacheDir: () => '/unused',
      readBytes: () => Promise.resolve(null),
      writeCache: () => Promise.resolve(),
    });

    expect(loaded).toMatchObject({ fromArchive: false, digest: `sha256:${hash}` });
    expect(calls).toEqual([
      'https://github.com/juliopolycarpo/mangostudio/releases/download/v1.2.3-canary/canary-manifest.json',
      'https://github.com/juliopolycarpo/mangostudio/releases/download/v1.2.3-canary/SHA256SUMS',
      `https://github.com/juliopolycarpo/mangostudio/releases/download/v1.2.3-canary/${asset}`,
    ]);
    expect(resolved).toBe(3);
  });

  // Same refusal the WSL provisioner makes, on the path SSH push and the live
  // self-update share: the rolling tag can hand back a runtime from a newer
  // commit whose checksum verifies, and the mismatch is only visible here.
  it('refuses to fetch bytes the rolling tag has moved past', async () => {
    const manifest = JSON.stringify({
      schemaVersion: 1,
      channel: 'canary',
      version: '1.2.3-canary.9999999',
      assetVersion: '1.2.3-canary',
      sourceSha: '9999999999999999999999999999999999999999',
      builtAt: '2026-08-05T00:00:00.000Z',
      pairs: [
        {
          platform: 'linux-x64',
          hub: { asset: 'mangostudio-1.2.3-canary-linux-x64', digest: 'a'.repeat(64) },
          runtime: {
            asset: 'mangostudio-runtime-1.2.3-canary-linux-x64',
            digest: 'b'.repeat(64),
          },
        },
      ],
    });
    const calls: string[] = [];

    await expect(
      loadRuntimeReleaseBytes('linux-x64', {
        version: '1.2.3-canary.abcdef0',
        fetch: ((input: string | URL | Request) => {
          calls.push(String(input));
          return Promise.resolve(new Response(manifest));
        }) as unknown as typeof fetch,
        resolveHostname: () => Promise.resolve([{ address: '140.82.112.4', family: 4 as const }]),
        cacheDir: () => '/unused',
        readBytes: () => Promise.resolve(null),
        writeCache: () => Promise.resolve(),
      })
    ).rejects.toThrow(/rolling canary release has moved on/);

    // Refused on the manifest alone: no checksum fetch, no asset download.
    expect(calls).toHaveLength(1);
  });

  // The manifest read that clears the refusal check above already named a
  // digest for this platform's raw asset. Trusting it instead of a second
  // SHA256SUMS fetch removes the only remaining window for the tag to move
  // between the check and the download.
  it('binds a rolling raw asset to the digest a validated manifest already named, skipping a second SHA256SUMS fetch', async () => {
    const asset = 'mangostudio-runtime-1.2.3-canary-linux-x64';
    const bytes = new TextEncoder().encode('canary-runtime');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const manifest = JSON.stringify({
      schemaVersion: 1,
      channel: 'canary',
      version: '1.2.3-canary.abcdef0',
      assetVersion: '1.2.3-canary',
      sourceSha: 'abcdef0abcdef0abcdef0abcdef0abcdef0abcde',
      builtAt: '2026-08-05T00:00:00.000Z',
      pairs: [
        {
          platform: 'linux-x64',
          hub: { asset: 'mangostudio-1.2.3-canary-linux-x64', digest: 'a'.repeat(64) },
          runtime: { asset, digest: hash },
        },
      ],
    });
    const calls: string[] = [];

    const loaded = await loadRuntimeReleaseBytes('linux-x64', {
      version: '1.2.3-canary.abcdef0',
      fetch: ((input: string | URL | Request) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith('/canary-manifest.json')) {
          return Promise.resolve(new Response(manifest));
        }
        return Promise.resolve(new Response(bytes));
      }) as unknown as typeof fetch,
      resolveHostname: () => Promise.resolve([{ address: '140.82.112.4', family: 4 as const }]),
      cacheDir: () => '/unused',
      readBytes: () => Promise.resolve(null),
      writeCache: () => Promise.resolve(),
    });

    expect(loaded).toMatchObject({ fromArchive: false, digest: `sha256:${hash}` });
    // No SHA256SUMS fetch: the manifest-bound digest already answered it.
    expect(calls).toEqual([
      'https://github.com/juliopolycarpo/mangostudio/releases/download/v1.2.3-canary/canary-manifest.json',
      `https://github.com/juliopolycarpo/mangostudio/releases/download/v1.2.3-canary/${asset}`,
    ]);
  });

  // A rolling tag republishes SHA256SUMS under the same name as newer builds
  // land, so a verify command built from a fresh fetch checks today's build
  // against yesterday's cached bytes. Recording the verified digest next to
  // the file at write time is what lets a later verify check the file against
  // itself instead — see `runtimeDigestSidecarPath`.
  it('writes a digest sidecar next to the cached bytes when the write succeeds', async () => {
    const asset = 'mangostudio-runtime-1.2.3-canary-linux-x64';
    const bytes = new TextEncoder().encode('canary-runtime');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const manifest = JSON.stringify({
      schemaVersion: 1,
      channel: 'canary',
      version: '1.2.3-canary.abcdef0',
      assetVersion: '1.2.3-canary',
      sourceSha: 'abcdef0abcdef0abcdef0abcdef0abcdef0abcde',
      builtAt: '2026-08-05T00:00:00.000Z',
      pairs: [
        {
          platform: 'linux-x64',
          hub: { asset: 'mangostudio-1.2.3-canary-linux-x64', digest: 'a'.repeat(64) },
          runtime: { asset, digest: hash },
        },
      ],
    });
    const written: Array<{ path: string; bytes: Uint8Array }> = [];

    const loaded = await loadRuntimeReleaseBytes('linux-x64', {
      version: '1.2.3-canary.abcdef0',
      fetch: ((input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith('/canary-manifest.json')) {
          return Promise.resolve(new Response(manifest));
        }
        return Promise.resolve(new Response(bytes));
      }) as unknown as typeof fetch,
      resolveHostname: () => Promise.resolve([{ address: '140.82.112.4', family: 4 as const }]),
      cacheDir: () => '/unused',
      readBytes: () => Promise.resolve(null),
      writeCache: (path, writtenBytes) => {
        written.push({ path, bytes: writtenBytes });
        return Promise.resolve();
      },
    });

    expect(loaded.cached).toBe(true);
    const assetEntry = written.find((entry) => entry.path.endsWith(asset));
    expect(assetEntry).toBeDefined();
    const sidecarPath = runtimeDigestSidecarPath(assetEntry?.path ?? '');
    const sidecar = written.find((entry) => entry.path === sidecarPath);
    expect(sidecar).toBeDefined();
    expect(new TextDecoder().decode(sidecar?.bytes ?? new Uint8Array())).toBe(hash);
  });

  // A cache write that fails (full disk, permissions) must not be reported as
  // a success: `cached` is what the download-only staging action's whole
  // report hinges on.
  it('reports cached: false when the cache write rejects, without throwing', async () => {
    const bytes = new TextEncoder().encode('stable-runtime');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const asset = 'mangostudio-runtime-1.2.3-linux-x64';

    const loaded = await loadRuntimeReleaseBytes('linux-x64', {
      version: '1.2.3',
      fetch: ((input: string | URL | Request) => {
        const url = String(input);
        return Promise.resolve(
          url.endsWith('/SHA256SUMS') ? new Response(`${hash}  ${asset}\n`) : new Response(bytes)
        );
      }) as unknown as typeof fetch,
      resolveHostname: () => Promise.resolve([{ address: '140.82.112.4', family: 4 as const }]),
      cacheDir: () => '/unused',
      readBytes: () => Promise.resolve(null),
      writeCache: () => Promise.reject(new Error('disk full')),
    });

    expect(loaded).toMatchObject({ fromArchive: false, digest: `sha256:${hash}`, cached: false });
  });

  // Simulates the tag moving between the manifest read and the asset download:
  // same asset name, different bytes, still "clean" against a SHA256SUMS this
  // hub never consults for a bound asset. Without the binding, this is the
  // scenario where build B installs under the pair validated for build A.
  it('refuses a rolling raw asset whose bytes do not match the manifest-bound digest', async () => {
    const asset = 'mangostudio-runtime-1.2.3-canary-linux-x64';
    const manifest = JSON.stringify({
      schemaVersion: 1,
      channel: 'canary',
      version: '1.2.3-canary.abcdef0',
      assetVersion: '1.2.3-canary',
      sourceSha: 'abcdef0abcdef0abcdef0abcdef0abcdef0abcde',
      builtAt: '2026-08-05T00:00:00.000Z',
      pairs: [
        {
          platform: 'linux-x64',
          hub: { asset: 'mangostudio-1.2.3-canary-linux-x64', digest: 'a'.repeat(64) },
          runtime: { asset, digest: 'b'.repeat(64) },
        },
      ],
    });

    await expect(
      loadRuntimeReleaseBytes('linux-x64', {
        version: '1.2.3-canary.abcdef0',
        fetch: ((input: string | URL | Request) => {
          const url = String(input);
          if (url.endsWith('/canary-manifest.json')) {
            return Promise.resolve(new Response(manifest));
          }
          return Promise.resolve(new Response('a later build under the same rolling name'));
        }) as unknown as typeof fetch,
        resolveHostname: () => Promise.resolve([{ address: '140.82.112.4', family: 4 as const }]),
        cacheDir: () => '/unused',
        readBytes: () => Promise.resolve(null),
        writeCache: () => Promise.resolve(),
      })
    ).rejects.toThrow(/does not match the checksum/);
  });
});

describe('pinnedRuntimeDigest', () => {
  it('accepts what the sidecar writer records, trailing newline included', () => {
    const digest = 'a'.repeat(64);

    expect(pinnedRuntimeDigest(digest)).toBe(digest);
    expect(pinnedRuntimeDigest(`${digest}\n`)).toBe(digest);
  });

  // The cache directory is an ordinary user-writable directory, and the reader
  // interpolates this straight into a shell command it prints for somebody to
  // paste — then returns it in a response whose schema caps that command's
  // length. Anything unrecognised has to read as no sidecar so the caller keeps
  // its tag-based command, rather than a file's contents deciding either.
  it.each([
    ['an empty file', ''],
    ['whitespace only', '   \n'],
    ['a truncated digest', 'a'.repeat(63)],
    ['a digest with trailing junk', `${'a'.repeat(64)}x`],
    ['uppercase hex the writer never emits', 'A'.repeat(64)],
    ['a `sha256sum` line rather than a bare digest', `${'a'.repeat(64)}  runtime`],
    ['a shell fragment', '$(rm -rf ~)'],
    // Bounded on purpose: `RuntimeStagedAsset.verify` is capped at 4096
    // characters, so a large file here used to fail response validation and
    // take the whole runtime card down with it.
    ['a file far larger than any digest', 'a'.repeat(8192)],
  ])('reads %s as no sidecar', (_label, text) => {
    expect(pinnedRuntimeDigest(text)).toBeUndefined();
  });
});
