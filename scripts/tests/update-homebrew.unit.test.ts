import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { HOMEBREW_FORMULA_TEMPLATE_PATH, renderHomebrewFormula } from '../release/update-homebrew';

const SHAS = {
  'darwin-arm64': 'a'.repeat(64),
  'darwin-x64': 'b'.repeat(64),
  'linux-arm64': 'c'.repeat(64),
  'linux-x64': 'd'.repeat(64),
} as const;

const fixtureManifest = (version: string): string =>
  [
    ...Object.entries(SHAS).map(
      ([platform, sha]) => `${sha}  mangostudio-${version}-${platform}.tar.gz`
    ),
    `${'e'.repeat(64)}  mangostudio-${version}-windows-x64.zip`,
    `${'f'.repeat(64)}  mangostudio-${version}-frontend-dist.tar.gz`,
    `${'0'.repeat(64)}  install.sh`,
  ].join('\n');

const template = readFileSync(HOMEBREW_FORMULA_TEMPLATE_PATH, 'utf8');

describe('renderHomebrewFormula', () => {
  test('fills version, URLs, and all four platform checksums', () => {
    const rendered = renderHomebrewFormula({
      version: '0.1.0',
      manifest: fixtureManifest('0.1.0'),
      template,
    });

    expect(rendered).toContain('version "0.1.0"');
    for (const [platform, sha] of Object.entries(SHAS)) {
      expect(rendered).toContain(`sha256 "${sha}"`);
      expect(rendered).toContain(`releases/download/v0.1.0/mangostudio-0.1.0-${platform}.tar.gz`);
    }
    expect(rendered).not.toMatch(/\{\{[^}]*\}\}/);
  });

  test('normalizes a leading v in the version', () => {
    const rendered = renderHomebrewFormula({
      version: 'v0.1.0',
      manifest: fixtureManifest('0.1.0'),
      template,
    });

    expect(rendered).toContain('version "0.1.0"');
    expect(rendered).toContain('download/v0.1.0/');
  });

  test('fails loud when an expected archive is missing from SHA256SUMS', () => {
    const drifted = fixtureManifest('0.1.0').replace(
      'mangostudio-0.1.0-linux-arm64.tar.gz',
      'mangostudio-0.1.0-linux-aarch64.tar.gz'
    );

    expect(() => renderHomebrewFormula({ version: '0.1.0', manifest: drifted, template })).toThrow(
      /does not contain mangostudio-0\.1\.0-linux-arm64\.tar\.gz/
    );
  });

  test('rejects versions that are not semver', () => {
    expect(() =>
      renderHomebrewFormula({ version: 'latest', manifest: fixtureManifest('0.1.0'), template })
    ).toThrow(/Invalid release version/);
  });

  test('rejects templates with unknown placeholders left unfilled', () => {
    expect(() =>
      renderHomebrewFormula({
        version: '0.1.0',
        manifest: fixtureManifest('0.1.0'),
        template: 'sha256 "{{SHA_WINDOWS_X64}}"',
      })
    ).toThrow(/\{\{SHA_WINDOWS_X64\}\} was not filled/);
  });
});
