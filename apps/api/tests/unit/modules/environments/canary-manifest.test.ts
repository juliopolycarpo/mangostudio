import { describe, expect, it } from 'bun:test';
import {
  type CanaryManifest,
  canaryPairRefusal,
  checkRollingPair,
  parseCanaryManifest,
} from '../../../../src/modules/environments/domain/canary-manifest';

const MANIFEST: CanaryManifest = {
  schemaVersion: 1,
  channel: 'canary',
  version: '1.2.3-canary.abcdef0',
  assetVersion: '1.2.3-canary',
  sourceSha: 'abcdef0123456789abcdef0123456789abcdef01',
  builtAt: '2026-08-05T00:00:00.000Z',
  pairs: [
    {
      platform: 'linux-x64',
      hub: { asset: 'mangostudio-1.2.3-canary-linux-x64', digest: 'a'.repeat(64) },
      runtime: { asset: 'mangostudio-runtime-1.2.3-canary-linux-x64', digest: 'b'.repeat(64) },
    },
    {
      platform: 'darwin-arm64',
      hub: { asset: 'mangostudio-1.2.3-canary-darwin-arm64', digest: 'c'.repeat(64) },
      runtime: { asset: 'mangostudio-runtime-1.2.3-canary-darwin-arm64', digest: 'd'.repeat(64) },
    },
  ],
};

describe('parseCanaryManifest', () => {
  it('round-trips the document the release script writes', () => {
    expect(parseCanaryManifest(JSON.stringify(MANIFEST))).toEqual(MANIFEST);
  });

  // Treated as missing rather than fatal: a rolling release cut before this
  // record existed has none, and refusing to provision from one would break
  // the channel to add a check.
  it.each([
    ['not json at all', 'not json at all'],
    ['a json array', '[]'],
    ['a json scalar', '"canary"'],
    ['another channel', JSON.stringify({ ...MANIFEST, channel: 'stable' })],
    ['a missing version', JSON.stringify({ ...MANIFEST, version: undefined })],
    ['an empty version', JSON.stringify({ ...MANIFEST, version: '' })],
    ['pairs that are not a list', JSON.stringify({ ...MANIFEST, pairs: {} })],
    ['a pair missing its runtime', JSON.stringify({ ...MANIFEST, pairs: [{ platform: 'x' }] })],
    [
      'a pair whose digest is not a string',
      JSON.stringify({
        ...MANIFEST,
        pairs: [
          { platform: 'x', hub: { asset: 'a', digest: 1 }, runtime: { asset: 'b', digest: '' } },
        ],
      }),
    ],
  ])('returns null for %s', (_label, text) => {
    expect(parseCanaryManifest(text)).toBeNull();
  });

  // Exact-match, not `>=`: the field exists so a later layout can change what
  // the same key means, and a hub that acted on a shape it cannot evaluate
  // would be enforcing a guardrail it does not understand.
  it.each([[0], [2], [99]])('returns null for schema version %i', (schemaVersion) => {
    expect(parseCanaryManifest(JSON.stringify({ ...MANIFEST, schemaVersion }))).toBeNull();
  });
});

describe('checkRollingPair', () => {
  const bytesOf = (manifest: unknown): Uint8Array =>
    new TextEncoder().encode(JSON.stringify(manifest));

  const tolerateAll = () => true;

  it('returns the manifest and no refusal when the tag still serves this hub', async () => {
    const result = await checkRollingPair({
      fetchManifest: async () => bytesOf(MANIFEST),
      tolerate: tolerateAll,
      hubVersion: '1.2.3-canary.abcdef0',
      platformId: 'linux-x64',
    });

    expect(result.manifest).toEqual(MANIFEST);
    expect(result.refusal).toBeNull();
  });

  it('reports a refusal, and still hands back the manifest that explains it', async () => {
    const result = await checkRollingPair({
      fetchManifest: async () => bytesOf(MANIFEST),
      tolerate: tolerateAll,
      hubVersion: '1.2.3-canary.0000111',
      platformId: 'linux-x64',
    });

    expect(result.manifest).toEqual(MANIFEST);
    expect(result.refusal).toContain('has moved on');
  });

  // A rolling release cut before the manifest existed publishes none, so a
  // tolerated fetch failure has to read as "no manifest", not as an outage.
  it('treats a tolerated fetch failure as no manifest', async () => {
    const result = await checkRollingPair({
      fetchManifest: () => Promise.reject(new Error('404')),
      tolerate: tolerateAll,
      hubVersion: '1.2.3-canary.abcdef0',
      platformId: 'linux-x64',
    });

    expect(result).toEqual({ manifest: null, refusal: null });
  });

  // The predicate is the whole point of the parameterisation: each caller keeps
  // its own error classes, and anything it does not recognise must not be
  // swallowed by a guard that only meant to tolerate a missing file.
  it('rethrows a failure the caller does not tolerate', async () => {
    const boom = new Error('socket closed');

    await expect(
      checkRollingPair({
        fetchManifest: () => Promise.reject(boom),
        tolerate: () => false,
        hubVersion: '1.2.3-canary.abcdef0',
        platformId: 'linux-x64',
      })
    ).rejects.toThrow('socket closed');
  });

  it('treats an unparseable manifest as no manifest rather than a refusal', async () => {
    const result = await checkRollingPair({
      fetchManifest: async () => new TextEncoder().encode('{'),
      tolerate: tolerateAll,
      hubVersion: '1.2.3-canary.abcdef0',
      platformId: 'linux-x64',
    });

    expect(result).toEqual({ manifest: null, refusal: null });
  });
});

describe('canaryPairRefusal', () => {
  it('allows a hub whose own version is what the tag currently publishes', () => {
    expect(canaryPairRefusal(MANIFEST, '1.2.3-canary.abcdef0', 'linux-x64')).toBeNull();
  });

  // The failure this exists to prevent: the rolling tag is clobbered on every
  // green commit, so an older hub asking for "its" runtime gets a newer one.
  // The checksum verifies — SHA256SUMS was clobbered with it — so nothing else
  // catches the mismatch until the handshake refuses it on the target machine.
  it('refuses a hub the rolling tag has moved past, naming both versions', () => {
    const refusal = canaryPairRefusal(MANIFEST, '1.2.3-canary.0000111', 'linux-x64');

    expect(refusal).toContain('1.2.3-canary.abcdef0');
    expect(refusal).toContain('1.2.3-canary.0000111');
    expect(refusal).toContain('abcdef0');
    expect(refusal).toContain('Update MangoStudio');
  });

  it('refuses a platform canary does not publish, naming the ones it does', () => {
    const refusal = canaryPairRefusal(MANIFEST, '1.2.3-canary.abcdef0', 'linux-arm64');

    expect(refusal).toContain('linux-arm64');
    expect(refusal).toContain('linux-x64, darwin-arm64');
    expect(refusal).toContain('stable publishes every platform');
  });
});
