import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createReleaseAssetPlan, selectCanaryAssets } from '../lib/release-assets';
import { stageCanaryAssets } from '../release/stage-canary-assets';

/** The sha-stamped version the binaries report, their file names and their tag. */
const VERSION = '1.2.3-canary.abcdef0';
const SOURCE_SHA = 'abcdef0123456789abcdef0123456789abcdef01';

let workDir: string;
let inDir: string;
let outDir: string;

/** Writes a stand-in for every asset the built release would have produced. */
function seedBuiltAssets(): void {
  const plan = createReleaseAssetPlan({ version: VERSION, assetsDir: inDir });
  const selection = selectCanaryAssets(plan);
  for (const assetName of [...selection.archives, ...selection.rawBinaries, ...selection.scripts]) {
    writeFileSync(join(inDir, assetName), `contents of ${assetName}`);
  }
}

function stage() {
  return stageCanaryAssets({
    version: VERSION,
    sourceSha: SOURCE_SHA,
    inDir,
    outDir,
    builtAt: '2026-08-05T00:00:00.000Z',
  });
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'canary-stage-'));
  inDir = join(workDir, 'release-assets');
  outDir = join(workDir, 'github-canary-assets');
  mkdirSync(inDir, { recursive: true });
  seedBuiltAssets();
});

afterEach(() => {
  rmSync(workDir, { force: true, recursive: true });
});

describe('stageCanaryAssets', () => {
  test('stages every archive plus the curated raw pairs under their built names', () => {
    const staged = stage();

    expect(staged).toContain(`mangostudio-${VERSION}-linux-x64`);
    expect(staged).toContain(`mangostudio-runtime-${VERSION}-linux-x64`);
    expect(staged).toContain(`mangostudio-runtime-${VERSION}-windows-x64.exe`);
    expect(staged).toContain(`mangostudio-${VERSION}-linux-arm64.tar.gz`);
    // Curated: the uncurated platforms contribute an archive but no raw pair.
    expect(staged).not.toContain(`mangostudio-runtime-${VERSION}-linux-arm64`);
    expect(staged).not.toContain(`mangostudio-${VERSION}-linux-arm64`);
    // The sha stays in every name: one tag per commit, so nothing is rewritten
    // onto a rolling version that several builds would share.
    expect(
      staged
        .filter((name) => name.startsWith('mangostudio-'))
        .every((name) => name.includes('abcdef0'))
    ).toBe(true);
  });

  test('stages the install scripts under their own names, which carry no version', () => {
    const staged = stage();

    expect(staged).toContain('install.sh');
    expect(staged).toContain('install.ps1');
    expect(readFileSync(join(outDir, 'install.sh'), 'utf8')).toBe(
      readFileSync(join(inDir, 'install.sh'), 'utf8')
    );
  });

  test('records the source commit and each pair digest in the manifest', () => {
    stage();
    const manifest = JSON.parse(readFileSync(join(outDir, 'canary-manifest.json'), 'utf8'));

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      channel: 'canary',
      version: VERSION,
      assetVersion: VERSION,
      sourceSha: SOURCE_SHA,
      builtAt: '2026-08-05T00:00:00.000Z',
    });
    expect(manifest.pairs.map((pair: { platform: string }) => pair.platform)).toEqual([
      'linux-x64',
      'darwin-arm64',
      'windows-x64',
    ]);

    // The digest has to be of the staged bytes, or the manifest describes
    // something nobody can download.
    const [linux] = manifest.pairs;
    const staged = readFileSync(join(outDir, linux.runtime.asset));
    expect(linux.runtime.digest).toBe(createHash('sha256').update(staged).digest('hex'));
  });

  // A provenance record nobody can verify is decoration, and the old shell step
  // globbed `mangostudio-*` for its checksums — which would have skipped it.
  test('checksums the manifest alongside every staged asset', () => {
    const staged = stage();
    const sums = readFileSync(join(outDir, 'SHA256SUMS'), 'utf8');
    const listed = sums
      .trim()
      .split('\n')
      .map((line) => line.split(/\s+/)[1]);

    expect(listed).toContain('canary-manifest.json');
    expect(new Set(listed)).toEqual(new Set(staged));
    for (const line of sums.trim().split('\n')) {
      const [digest, name] = line.split(/\s+/);
      expect(digest).toBe(
        createHash('sha256')
          .update(readFileSync(join(outDir, name)))
          .digest('hex')
      );
    }
  });

  test('replaces a previous staging directory rather than merging into it', () => {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'mangostudio-0.0.1-canary-linux-x64'), 'from an older run');

    stage();

    expect(readFileSync(join(outDir, 'SHA256SUMS'), 'utf8')).not.toContain('0.0.1');
  });
});
