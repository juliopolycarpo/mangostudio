import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderScoopManifest, SCOOP_MANIFEST_TEMPLATE_PATH } from '../release/update-scoop';

const SHAS = {
  'windows-x64': 'e'.repeat(64),
  'windows-arm64': 'f'.repeat(64),
} as const;

const fixtureManifest = (version: string): string =>
  [
    ...Object.entries(SHAS).map(
      ([platform, sha]) => `${sha}  mangostudio-${version}-${platform}.zip`
    ),
    `${'a'.repeat(64)}  mangostudio-${version}-darwin-arm64.tar.gz`,
    `${'b'.repeat(64)}  mangostudio-${version}-linux-x64.tar.gz`,
  ].join('\n');

const template = readFileSync(SCOOP_MANIFEST_TEMPLATE_PATH, 'utf8');

describe('renderScoopManifest', () => {
  test('renders valid JSON with the version, URLs, and both Windows checksums', () => {
    const rendered = renderScoopManifest({
      version: '0.1.0',
      manifest: fixtureManifest('0.1.0'),
      template,
    });

    const manifest = JSON.parse(rendered) as {
      version: string;
      bin: string;
      architecture: Record<string, { url: string; hash: string }>;
    };
    expect(manifest.version).toBe('0.1.0');
    expect(manifest.bin).toBe('mangostudio.exe');
    expect(manifest.architecture['64bit']).toEqual({
      url: 'https://github.com/juliopolycarpo/mangostudio/releases/download/v0.1.0/mangostudio-0.1.0-windows-x64.zip',
      hash: SHAS['windows-x64'],
    });
    expect(manifest.architecture.arm64).toEqual({
      url: 'https://github.com/juliopolycarpo/mangostudio/releases/download/v0.1.0/mangostudio-0.1.0-windows-arm64.zip',
      hash: SHAS['windows-arm64'],
    });
    expect(rendered).not.toMatch(/\{\{[^}]*\}\}/);
  });

  test('leaves Scoop autoupdate $version/$sha256/$basename tokens untouched', () => {
    const rendered = renderScoopManifest({
      version: '0.1.0',
      manifest: fixtureManifest('0.1.0'),
      template,
    });

    const manifest = JSON.parse(rendered) as {
      autoupdate: {
        architecture: Record<string, { url: string }>;
        hash: { url: string; regex: string };
      };
    };
    expect(manifest.autoupdate.architecture['64bit'].url).toContain('v$version/');
    expect(manifest.autoupdate.architecture['64bit'].url).toContain('-$version-windows-x64.zip');
    expect(manifest.autoupdate.hash.regex).toBe('$sha256\\s+$basename');
  });

  test('normalizes a leading v in the version', () => {
    const rendered = renderScoopManifest({
      version: 'v0.1.0',
      manifest: fixtureManifest('0.1.0'),
      template,
    });

    expect(JSON.parse(rendered).version).toBe('0.1.0');
  });

  test('fails loud when an expected archive is missing from SHA256SUMS', () => {
    const drifted = fixtureManifest('0.1.0').replace(
      'mangostudio-0.1.0-windows-arm64.zip',
      'mangostudio-0.1.0-windows-aarch64.zip'
    );

    expect(() => renderScoopManifest({ version: '0.1.0', manifest: drifted, template })).toThrow(
      /does not contain mangostudio-0\.1\.0-windows-arm64\.zip/
    );
  });

  test('rejects versions that are not semver', () => {
    expect(() =>
      renderScoopManifest({ version: 'latest', manifest: fixtureManifest('0.1.0'), template })
    ).toThrow(/Invalid release version/);
  });
});
