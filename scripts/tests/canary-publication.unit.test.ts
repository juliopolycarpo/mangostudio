import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

import {
  type RegistryClient,
  type RegistryResponse,
  verifyCanaryNpmPublication,
} from '../lib/canary-publication';
import type { DistributionManifest } from '../lib/distribution-manifest';
import { MAIN_PACKAGE, NPM_PLATFORMS, platformPackageName } from '../lib/npm-pack';

const REGISTRY = 'https://registry.npmjs.org';
const VERSION = '1.2.3-canary.aaaaaaa';
const EXPECTED_NAMES = [
  '@mangostudio/cli-linux-x64',
  '@mangostudio/cli-linux-arm64',
  '@mangostudio/cli-darwin-x64',
  '@mangostudio/cli-darwin-arm64',
  '@mangostudio/cli-win32-x64',
  '@mangostudio/cli-win32-arm64',
  'mangostudio',
];

function versionUrl(name: string): string {
  return `${REGISTRY}/${encodeURIComponent(name)}/${VERSION}`;
}
function tagsUrl(name: string): string {
  return `${REGISTRY}/-/package/${encodeURIComponent(name)}/dist-tags`;
}
function tarballUrl(name: string): string {
  return `${REGISTRY}/${name}/-/${name.split('/').at(-1)}-${VERSION}.tgz`;
}
function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

class FakeRegistry implements RegistryClient {
  readonly json = new Map<string, RegistryResponse<unknown>>();
  readonly archives = new Map<string, RegistryResponse<Uint8Array>>();
  readonly failures = new Map<string, Error>();
  readonly calls: string[] = [];

  getJson(url: string): Promise<RegistryResponse<unknown>> {
    this.calls.push(url);
    const failure = this.failures.get(url);
    if (failure) throw failure;
    const response = this.json.get(url);
    if (!response) throw new Error(`Unexpected fake registry JSON request: ${url}`);
    return Promise.resolve(response);
  }
  getBytes(url: string): Promise<RegistryResponse<Uint8Array>> {
    this.calls.push(url);
    const failure = this.failures.get(url);
    if (failure) throw failure;
    const response = this.archives.get(url);
    if (!response) throw new Error(`Unexpected fake registry archive request: ${url}`);
    return Promise.resolve(response);
  }
}

interface Fixture {
  readonly manifest: DistributionManifest;
  readonly registry: FakeRegistry;
  readonly contents: Map<string, Record<string, string>>;
}

async function fixture(): Promise<Fixture> {
  const manifest: DistributionManifest = {
    schemaVersion: 5,
    sourceSha: 'a'.repeat(40),
    dirty: false,
    packageVersion: VERSION,
    channel: 'canary',
    bunVersion: '1.4.4',
    bunRevision: 'b'.repeat(40),
    runtimeProfile: 'shipping',
    targets: [],
    files: [],
  };
  const registry = new FakeRegistry();
  const descriptions = [
    ...NPM_PLATFORMS.map((platform) => ({
      name: platformPackageName(platform),
      directory: `dist-npm/${platform.os}-${platform.cpu}`,
      paths: [platform.binary, platform.runtimeBinary],
    })),
    { name: MAIN_PACKAGE, directory: 'dist-npm/cli', paths: ['README.md', 'bin/mangostudio.js'] },
  ];
  const files: DistributionManifest['files'][number][] = [];
  const contents = new Map<string, Record<string, string>>();
  for (const description of descriptions) {
    const entries: Record<string, string> = {
      'package/package.json': JSON.stringify({ name: description.name, version: VERSION }),
    };
    for (const path of description.paths)
      entries[`package/${path}`] = `${description.name} ${path} approved content`;
    contents.set(description.name, entries);
    for (const [path, content] of Object.entries(entries)) {
      const bytes = Buffer.from(content);
      files.push({
        path: `${description.directory}/${path.slice('package/'.length)}`,
        size: bytes.byteLength,
        sha256: sha256(bytes),
      });
    }
    registry.json.set(tagsUrl(description.name), {
      status: 200,
      body: { latest: '1.2.2', canary: VERSION },
    });
    await replaceArchive(registry, description.name, entries);
  }
  return { manifest: { ...manifest, files }, registry, contents };
}

async function replaceArchive(
  registry: FakeRegistry,
  name: string,
  entries: Record<string, string>
): Promise<void> {
  let bytes: Uint8Array = await new Bun.Archive(entries, { compress: 'gzip' }).bytes();
  if (/^@mangostudio\/cli-(linux|darwin)-/.test(name)) {
    bytes = withTarMode(bytes, 'package/mangostudio', '0000755');
    bytes = withTarMode(bytes, 'package/mangostudio-runtime', '0000755');
  }
  setArchiveBytes(registry, name, bytes);
}
function withTarMode(bytes: Uint8Array, member: string, mode: string): Uint8Array {
  const tar = gunzipSync(bytes);
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    const path = header.subarray(0, 100).toString().replace(/\0.*$/s, '');
    const size =
      Number.parseInt(header.subarray(124, 136).toString().replace(/\0.*$/s, '').trim(), 8) || 0;
    if (path === member) {
      header.write(`${mode}\0`, 100, 8, 'ascii');
      header.fill(32, 148, 156);
      const checksum = header
        .reduce((total, byte) => total + byte, 0)
        .toString(8)
        .padStart(6, '0');
      header.write(`${checksum}\0 `, 148, 8, 'ascii');
      return gzipSync(tar);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`Expected fixture tar member ${member}`);
}

function setArchiveBytes(registry: FakeRegistry, name: string, bytes: Uint8Array): void {
  const url = tarballUrl(name);
  registry.archives.set(url, { status: 200, body: bytes });
  registry.json.set(versionUrl(name), {
    status: 200,
    body: {
      name,
      version: VERSION,
      _id: `${name}@${VERSION}`,
      dist: {
        integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
        tarball: url,
        attestations: {
          url: `${REGISTRY}/-/npm/v1/attestations/${name.replace('/', '%2f')}@${VERSION}`,
          provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
        },
      },
    },
  });
}
function metadata(registry: FakeRegistry, name = MAIN_PACKAGE): Record<string, unknown> {
  const value = registry.json.get(versionUrl(name))?.body;
  if (!value || typeof value !== 'object') throw new Error(`Fixture lacks ${name} metadata`);
  return value as Record<string, unknown>;
}
function dist(registry: FakeRegistry): Record<string, unknown> {
  return metadata(registry).dist as Record<string, unknown>;
}

describe('canary npm publication integrity', () => {
  test('verifies all six platforms and wrapper before reporting published identities and channel owners', async () => {
    const { manifest, registry } = await fixture();
    const result = await verifyCanaryNpmPublication(manifest, registry);
    expect(result.present.map((entry) => entry.name)).toEqual(EXPECTED_NAMES);
    expect(result.missing).toEqual([]);
    expect(result.canary).toEqual(
      Object.fromEntries(EXPECTED_NAMES.map((name) => [name, VERSION]))
    );
    expect(registry.calls).toHaveLength(21);
    expect(
      result.present.every(
        (entry) =>
          entry.integrity.startsWith('sha512-') && entry.provenanceUrl.includes('/attestations/')
      )
    ).toBe(true);
  });
  test('distinguishes partial versions from complete publication and retains other channel owners', async () => {
    const { manifest, registry } = await fixture();
    registry.json.set(versionUrl(MAIN_PACKAGE), {
      status: 404,
      body: { error: 'version not found' },
    });
    registry.json.set(tagsUrl(MAIN_PACKAGE), {
      status: 200,
      body: { canary: '1.2.3-canary.bbbbbbb', latest: '1.2.2' },
    });
    const result = await verifyCanaryNpmPublication(manifest, registry);
    expect(result.present).toHaveLength(6);
    expect(result.missing).toEqual(['mangostudio']);
    expect(result.canary.mangostudio).toBe('1.2.3-canary.bbbbbbb');
    expect(registry.calls).not.toContain(tarballUrl(MAIN_PACKAGE));
  });
  test('only actual HTTP 404 establishes absent versions and packages', async () => {
    const { manifest, registry } = await fixture();
    for (const name of EXPECTED_NAMES) {
      registry.json.set(versionUrl(name), { status: 404, body: {} });
      registry.json.set(tagsUrl(name), { status: 404, body: {} });
    }
    const result = await verifyCanaryNpmPublication(manifest, registry);
    expect(result.present).toEqual([]);
    expect(result.missing).toEqual(EXPECTED_NAMES);
    expect(Object.values(result.canary)).toEqual(Array(7).fill(null));
  });
  test.each([401, 403, 429, 500, 503])(
    'HTTP %i cannot masquerade as absent publication',
    async (status) => {
      const { manifest, registry } = await fixture();
      registry.json.set(versionUrl(EXPECTED_NAMES[0] ?? ''), {
        status,
        body: { error: 'not found' },
      });
      await expect(verifyCanaryNpmPublication(manifest, registry)).rejects.toThrow(
        `expected HTTP 200, received ${status}`
      );
    }
  );
  test('transport errors cannot masquerade as absent publication', async () => {
    const { manifest, registry } = await fixture();
    registry.failures.set(
      versionUrl(EXPECTED_NAMES[0] ?? ''),
      new Error('registry fixture network refused')
    );
    await expect(verifyCanaryNpmPublication(manifest, registry)).rejects.toThrow(
      'registry fixture network refused'
    );
  });
  test('rejects missing channel read for an existing package', async () => {
    const { manifest, registry } = await fixture();
    registry.json.set(tagsUrl(MAIN_PACKAGE), { status: 404, body: {} });
    await expect(verifyCanaryNpmPublication(manifest, registry)).rejects.toThrow(
      'expected HTTP 200, received 404'
    );
  });
  test.each([null, [], { canary: 42 }, { latest: 'not-semver' }].map((body) => [body]))(
    'rejects malformed dist-tag result %j',
    async (body) => {
      const { manifest, registry } = await fixture();
      registry.json.set(tagsUrl(MAIN_PACKAGE), { status: 200, body });
      await expect(verifyCanaryNpmPublication(manifest, registry)).rejects.toThrow(
        /Invalid dist-tag/
      );
    }
  );
  test('reports absent canary tag while preserving a valid stable latest tag', async () => {
    const { manifest, registry } = await fixture();
    registry.json.set(tagsUrl(MAIN_PACKAGE), { status: 200, body: { latest: '1.2.2' } });
    expect((await verifyCanaryNpmPublication(manifest, registry)).canary.mangostudio).toBe(null);
  });
  test.each([
    ['name', 'wrong-package'],
    ['version', '1.2.3'],
    ['_id', 'mangostudio@wrong'],
  ])('rejects wrong metadata %s=%s', async (field, value) => {
    const { manifest, registry } = await fixture();
    metadata(registry)[field] = value;
    await expect(verifyCanaryNpmPublication(manifest, registry)).rejects.toThrow(
      'Registry identity mismatch for mangostudio'
    );
  });
  test.each([null, [], {}, { name: MAIN_PACKAGE }].map((body) => [body]))(
    'rejects incomplete metadata %j',
    async (body) => {
      const { manifest, registry } = await fixture();
      registry.json.set(versionUrl(MAIN_PACKAGE), { status: 200, body });
      await expect(verifyCanaryNpmPublication(manifest, registry)).rejects.toThrow(
        /metadata|identity mismatch/
      );
    }
  );
  test.each(['sha1-abc', '', 'sha512-a', `sha512-${'A'.repeat(85)}B==`])(
    'rejects invalid integrity %s',
    async (integrity) => {
      const { manifest, registry } = await fixture();
      dist(registry).integrity = integrity;
      await expect(verifyCanaryNpmPublication(manifest, registry)).rejects.toThrow(
        'expected canonical sha512 SRI'
      );
    }
  );
  test.each([
    'http://registry.npmjs.org/mangostudio.tgz',
    'https://example.org/mangostudio.tgz',
    'https://registry.npmjs.org/other/-/other.tgz',
  ])('rejects untrusted/wrong tarball %s', async (tarball) => {
    const { manifest, registry } = await fixture();
    dist(registry).tarball = tarball;
    await expect(verifyCanaryNpmPublication(manifest, registry)).rejects.toThrow(
      'Invalid tarball for mangostudio'
    );
  });
  test.each([
    null,
    {},
    {
      url: 'https://example.org/attestation',
      provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
    },
    {
      url: `${REGISTRY}/-/npm/v1/attestations/mangostudio@${VERSION}`,
      provenance: { predicateType: 'unsupported' },
    },
  ])('requires usable provenance metadata %j', async (attestations) => {
    const { manifest, registry } = await fixture();
    dist(registry).attestations = attestations;
    await expect(verifyCanaryNpmPublication(manifest, registry)).rejects.toThrow(
      /attestations|provenance/
    );
  });
  test('rejects corrupt downloaded archive before reading its files', async () => {
    const { manifest, registry } = await fixture();
    registry.archives.set(tarballUrl(MAIN_PACKAGE), {
      status: 200,
      body: new Uint8Array([1, 2, 3]),
    });
    await expect(verifyCanaryNpmPublication(manifest, registry)).rejects.toThrow(
      'Registry archive integrity mismatch for mangostudio'
    );
  });
  test('rejects failed download of a published package', async () => {
    const { manifest, registry } = await fixture();
    registry.archives.set(tarballUrl(MAIN_PACKAGE), { status: 403, body: new Uint8Array() });
    await expect(verifyCanaryNpmPublication(manifest, registry)).rejects.toThrow(
      'expected HTTP 200, received 403'
    );
  });
  test('same version/source with a replacement build cannot pass published-byte verification', async () => {
    const { manifest, registry, contents } = await fixture();
    const entries = {
      ...contents.get(MAIN_PACKAGE),
      'package/bin/mangostudio.js': 'different compiler output from the same source',
    };
    await replaceArchive(registry, MAIN_PACKAGE, entries);
    await expect(verifyCanaryNpmPublication(manifest, registry)).rejects.toThrow(
      'Published bytes mismatch for mangostudio package/bin/mangostudio.js'
    );
  });
  test.each(['missing', 'extra'])('rejects %s archive files', async (mutation) => {
    const { manifest, registry, contents } = await fixture();
    const entries = { ...contents.get(MAIN_PACKAGE) };
    if (mutation === 'missing') delete entries['package/README.md'];
    else entries['package/unapproved-file'] = 'not in manifest';
    await replaceArchive(registry, MAIN_PACKAGE, entries);
    await expect(verifyCanaryNpmPublication(manifest, registry)).rejects.toThrow(
      'Registry archive paths mismatch for mangostudio'
    );
  });
  test('rejects wrong packaged identity even if its bytes are listed by the approved manifest', async () => {
    const { manifest, registry, contents } = await fixture();
    const packageJson = JSON.stringify({ name: MAIN_PACKAGE, version: '1.2.2' });
    const entries = { ...contents.get(MAIN_PACKAGE), 'package/package.json': packageJson };
    await replaceArchive(registry, MAIN_PACKAGE, entries);
    const files = manifest.files.map((file) =>
      file.path === 'dist-npm/cli/package.json'
        ? {
            ...file,
            size: Buffer.byteLength(packageJson),
            sha256: sha256(Buffer.from(packageJson)),
          }
        : file
    );
    await expect(verifyCanaryNpmPublication({ ...manifest, files }, registry)).rejects.toThrow(
      'Packaged identity mismatch: expected mangostudio@1.2.3-canary.aaaaaaa'
    );
  });
  test.each([
    { runtimeProfile: 'light' },
    { dirty: true },
    { channel: 'pr' },
    { sourceSha: 'aaaaaaa' },
    { packageVersion: '1.2.3-canary.bbbbbbb' },
  ])('rejects nonpublishing manifest identity %j before registry reads', async (mutation) => {
    const { manifest, registry } = await fixture();
    await expect(
      verifyCanaryNpmPublication({ ...manifest, ...mutation } as DistributionManifest, registry)
    ).rejects.toThrow('expected clean shipping canary');
    expect(registry.calls).toEqual([]);
  });
  test.each(['v1.2.3-canary.aaaaaaa', ' 1.2.3-canary.aaaaaaa'])(
    'rejects noncanonical distribution version %s before reads',
    async (packageVersion) => {
      const { manifest, registry } = await fixture();
      for (const name of EXPECTED_NAMES) {
        registry.json.set(
          `${REGISTRY}/${encodeURIComponent(name)}/${encodeURIComponent(packageVersion)}`,
          { status: 404, body: {} }
        );
      }
      await expect(
        verifyCanaryNpmPublication({ ...manifest, packageVersion }, registry)
      ).rejects.toThrow('expected clean shipping canary');
      expect(registry.calls).toEqual([]);
    }
  );
  test.each(['v1.2.3', ' 1.2.3'])('rejects noncanonical dist-tag version %s', async (canary) => {
    const { manifest, registry } = await fixture();
    registry.json.set(tagsUrl(MAIN_PACKAGE), { status: 200, body: { canary } });
    await expect(verifyCanaryNpmPublication(manifest, registry)).rejects.toThrow(
      'expected semver string'
    );
  });
  test('requires the complete seven-package manifest before registry reads', async () => {
    const { manifest, registry } = await fixture();
    const files = manifest.files.filter(
      (file) => file.path !== 'dist-npm/linux-x64/mangostudio-runtime'
    );
    await expect(verifyCanaryNpmPublication({ ...manifest, files }, registry)).rejects.toThrow(
      'expected dist-npm/linux-x64/mangostudio-runtime'
    );
    expect(registry.calls).toEqual([]);
  });
  test.each(['dist-npm/unapproved/package.json', 'dist-npm/cli/../escape', 'dist-npm/cli//bad'])(
    'rejects unsafe/unowned manifest path %s',
    async (path) => {
      const { manifest, registry } = await fixture();
      const files = [...manifest.files, { path, size: 0, sha256: 'a'.repeat(64) }];
      await expect(verifyCanaryNpmPublication({ ...manifest, files }, registry)).rejects.toThrow(
        `Invalid npm manifest path: ${path}`
      );
    }
  );
  test('rejects a NUL manifest path even when every package is absent', async () => {
    const { manifest, registry } = await fixture();
    for (const name of EXPECTED_NAMES) {
      registry.json.set(versionUrl(name), { status: 404, body: {} });
      registry.json.set(tagsUrl(name), { status: 404, body: {} });
    }
    const path = 'dist-npm/cli/invalid\0file';
    const files = [...manifest.files, { path, size: 0, sha256: 'a'.repeat(64) }];
    await expect(verifyCanaryNpmPublication({ ...manifest, files }, registry)).rejects.toThrow(
      `Invalid npm manifest path: ${path}`
    );
    expect(registry.calls).toEqual([]);
  });
  test.each([50, 49, 120])(
    'rejects tar member type %i hidden from the native file listing',
    async (type) => {
      const { manifest, registry } = await fixture();
      const bytes = registry.archives.get(tarballUrl(MAIN_PACKAGE))?.body;
      if (!bytes) throw new Error('Fixture missing wrapper archive');
      const tar = gunzipSync(bytes);
      tar[156] = type;
      const header = tar.subarray(0, 512);
      header.fill(32, 148, 156);
      const checksum = header
        .reduce((total, byte) => total + byte, 0)
        .toString(8)
        .padStart(6, '0');
      header.write(`${checksum}\0 `, 148, 8, 'ascii');
      setArchiveBytes(registry, MAIN_PACKAGE, gzipSync(tar));
      await expect(verifyCanaryNpmPublication(manifest, registry)).rejects.toThrow(
        'expected unique regular package file or directory'
      );
    }
  );
  test('rejects an invalid gzip payload even when its registry integrity matches', async () => {
    const { manifest, registry } = await fixture();
    setArchiveBytes(registry, MAIN_PACKAGE, new Uint8Array([1, 2, 3]));
    await expect(verifyCanaryNpmPublication(manifest, registry)).rejects.toThrow(
      'expected bounded gzip tar'
    );
  });
  test('rejects duplicate tar entries omitted by the native map', async () => {
    const { manifest, registry } = await fixture();
    const bytes = registry.archives.get(tarballUrl(MAIN_PACKAGE))?.body;
    if (!bytes) throw new Error('Fixture missing wrapper archive');
    const tar = gunzipSync(bytes);
    const size = Number.parseInt(tar.subarray(124, 136).toString(), 8);
    const first = tar.subarray(0, 512 + Math.ceil(size / 512) * 512);
    setArchiveBytes(registry, MAIN_PACKAGE, gzipSync(Buffer.concat([first, tar])));
    await expect(verifyCanaryNpmPublication(manifest, registry)).rejects.toThrow(
      'expected unique regular package file or directory'
    );
  });
});

test.each(['0000644', '0000641'])(
  'refuses unusable published Unix binary mode %s despite matching approved content',
  async (mode) => {
    const { manifest, registry } = await fixture();
    const name = '@mangostudio/cli-linux-x64';
    const bytes = registry.archives.get(tarballUrl(name))?.body;
    if (!bytes) throw new Error('Expected linux-x64 archive fixture');
    setArchiveBytes(registry, name, withTarMode(bytes, 'package/mangostudio', mode));
    await expect(verifyCanaryNpmPublication(manifest, registry)).rejects.toThrow(
      'expected executable Unix binary'
    );
  }
);

test.each(['changed octal digit', 'high-bit checksum'] as const)(
  'rejects an extra member hidden by %s',
  async (corruption) => {
    const { manifest, registry, contents } = await fixture();
    await replaceArchive(registry, MAIN_PACKAGE, {
      ...contents.get(MAIN_PACKAGE),
      'package/unapproved.txt': 'unapproved payload',
    });
    await expect(verifyCanaryNpmPublication(manifest, registry)).rejects.toThrow(
      'Registry archive paths mismatch'
    );
    const bytes = registry.archives.get(tarballUrl(MAIN_PACKAGE))?.body;
    if (!bytes) throw new Error('Expected wrapper archive fixture');
    const tar = gunzipSync(bytes);
    let offset = 0,
      checksumOffset = -1;
    while (offset + 512 <= tar.length) {
      const header = tar.subarray(offset, offset + 512);
      const path = header.subarray(0, 100).toString().replace(/\0.*$/s, '');
      const size = Number.parseInt(
        header.subarray(124, 136).toString().replace(/\0.*$/s, '').trim(),
        8
      );
      if (path === 'package/unapproved.txt') {
        checksumOffset = offset + 148;
        break;
      }
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    expect(checksumOffset).toBeGreaterThan(0);
    const corrupted = Buffer.from(tar);
    const originalByte = corrupted[checksumOffset];
    if (originalByte === undefined) throw new Error('Expected checksum fixture byte');
    corrupted[checksumOffset] =
      corruption === 'high-bit checksum' ? originalByte | 0x80 : originalByte === 48 ? 49 : 48;
    expect([...tar.keys()].filter((index) => tar[index] !== corrupted[index])).toEqual([
      checksumOffset,
    ]);
    setArchiveBytes(registry, MAIN_PACKAGE, gzipSync(corrupted));
    await expect(verifyCanaryNpmPublication(manifest, registry)).rejects.toThrow(
      corruption === 'high-bit checksum'
        ? 'Invalid npm tar checksum field for mangostudio: expected raw octal digits with NUL/space padding'
        : 'expected valid tar header checksum'
    );
  }
);

test('names the package and expected JSON shape when approved package.json is corrupt', async () => {
  const { manifest, registry, contents } = await fixture();
  const invalid = 'not a package manifest';
  await replaceArchive(registry, MAIN_PACKAGE, {
    ...contents.get(MAIN_PACKAGE),
    'package/package.json': invalid,
  });
  const files = manifest.files.map((file) =>
    file.path === 'dist-npm/cli/package.json'
      ? { ...file, size: Buffer.byteLength(invalid), sha256: sha256(Buffer.from(invalid)) }
      : file
  );
  await expect(verifyCanaryNpmPublication({ ...manifest, files }, registry)).rejects.toThrow(
    `Invalid packaged manifest for ${MAIN_PACKAGE}@${VERSION}: expected JSON object in package/package.json`
  );
});

test.each([
  ['checksum', 148, 8, 'digit'],
  ['checksum', 148, 8, 'padding'],
  ['size', 124, 12, 'digit'],
  ['size', 124, 12, 'padding'],
  ['mode', 100, 8, 'digit'],
  ['mode', 100, 8, 'padding'],
] as const)(
  'names invalid raw %s field bytes at %i width %i (%s)',
  async (field, start, width, location) => {
    const { manifest, registry } = await fixture();
    const bytes = registry.archives.get(tarballUrl(MAIN_PACKAGE))?.body;
    if (!bytes) throw new Error('Expected wrapper archive fixture');
    const tar = gunzipSync(bytes);
    const header = tar.subarray(0, 512);
    const digit = header
      .subarray(start, start + width)
      .reduce((last, byte, index) => (byte >= 48 && byte <= 55 ? index : last), -1);
    if (digit < 0) throw new Error(`Expected octal digits in ${field} fixture`);
    const index = location === 'padding' ? start + width - 1 : start + digit;
    const original = header[index];
    if (original === undefined) throw new Error(`Expected ${field} fixture byte ${index}`);
    if (location === 'digit') expect(original >= 48 && original <= 55).toBe(true);
    else expect(original === 0 || original === 32).toBe(true);
    header[index] = original | 0x80;
    if (field !== 'checksum') {
      // Keep the outer checksum valid so the raw mode/size value is the failure.
      header.fill(32, 148, 156);
      const checksum = header
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, '0');
      header.write(`${checksum}\0 `, 148, 8, 'ascii');
    }
    setArchiveBytes(registry, MAIN_PACKAGE, gzipSync(tar));
    await expect(verifyCanaryNpmPublication(manifest, registry)).rejects.toThrow(
      `Invalid npm tar ${field} field for mangostudio: expected raw octal digits with NUL/space padding`
    );
  }
);

test.each([
  ['checksum', 148, 8],
  ['size', 124, 12],
  ['mode', 100, 8],
] as const)('accepts standard raw %s octal padding at %i width %i', async (field, start, width) => {
  const { manifest, registry } = await fixture();
  const bytes = registry.archives.get(tarballUrl(MAIN_PACKAGE))?.body;
  if (!bytes) throw new Error('Expected wrapper archive fixture');
  const tar = gunzipSync(bytes);
  const header = tar.subarray(0, 512);
  const value = Number.parseInt(
    header
      .subarray(start, start + width)
      .toString('latin1')
      .replace(/\0.*$/s, '')
      .trim(),
    8
  );
  header.write(`${value.toString(8).padStart(width - 1, ' ')}\0`, start, width, 'ascii');
  if (field !== 'checksum') {
    header.fill(32, 148, 156);
    const checksum = header
      .reduce((sum, byte) => sum + byte, 0)
      .toString(8)
      .padStart(6, '0');
    header.write(`${checksum}\0 `, 148, 8, 'ascii');
  }
  setArchiveBytes(registry, MAIN_PACKAGE, gzipSync(tar));
  expect((await verifyCanaryNpmPublication(manifest, registry)).present).toHaveLength(7);
});
