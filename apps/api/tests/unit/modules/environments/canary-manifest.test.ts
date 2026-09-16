import { describe, expect, it } from 'bun:test';
import {
  type CanaryManifest,
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

  // `sourceSha` stops at no refusal message: a rolling install writes it into
  // the target machine's `runtime.json`, where the slot schema bounds it at 64
  // characters — and a stored config that fails that check is discarded whole,
  // consent included. A manifest carrying a sha this parser would not recognise
  // must read as no manifest here rather than brick consent over there.
  it.each([
    ['an over-long sha', 'a'.repeat(65)],
    ['an empty sha', ''],
    ['a sha too short to identify a commit', 'abcdef'],
    ['a sha that is not hex', 'zzzzzzz'],
    ['an uppercase sha', 'ABCDEF0'],
    ['a sha with surrounding whitespace', ' abcdef0 '],
  ])('returns null for %s', (_label, sourceSha) => {
    expect(parseCanaryManifest(JSON.stringify({ ...MANIFEST, sourceSha }))).toBeNull();
  });

  it('accepts the short sha a `git describe` build stamps', () => {
    expect(
      parseCanaryManifest(JSON.stringify({ ...MANIFEST, sourceSha: 'abcdef0' }))
    ).toMatchObject({ sourceSha: 'abcdef0' });
  });

  // Exact-match, not `>=`: the field exists so a later layout can change what
  // the same key means, and a hub that acted on a shape it cannot evaluate
  // would be enforcing a guardrail it does not understand.
  it.each([[0], [2], [99]])('returns null for schema version %i', (schemaVersion) => {
    expect(parseCanaryManifest(JSON.stringify({ ...MANIFEST, schemaVersion }))).toBeNull();
  });
});
