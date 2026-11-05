import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

import type { CanaryVisibilityWindow } from './canary-visibility';
import { type DistributionManifest, parseDistributionManifest } from './distribution-manifest';
import { MAIN_PACKAGE, NPM_PLATFORMS, platformPackageName } from './npm-pack';
import { isValidSemver, normalizeVersion } from './release-version';

const REGISTRY = 'https://registry.npmjs.org';
const PROVENANCE_PREDICATE = 'https://slsa.dev/provenance/v1';

/** A registry response whose HTTP status is retained for absence decisions. */
export interface RegistryResponse<T> {
  readonly status: number;
  readonly body: T;
}

/** External registry I/O; implementations must retain status and reject transport errors. */
export interface RegistryClient {
  getJson(url: string): Promise<RegistryResponse<unknown>>;
  getBytes(url: string): Promise<RegistryResponse<Uint8Array>>;
}

interface VerifiedCanaryPackage {
  readonly name: string;
  readonly integrity: string;
  readonly tarball: string;
  /** Presence of supported registry provenance metadata, not signature verification. */
  readonly provenanceUrl: string;
}

export interface CanaryNpmPublication {
  readonly present: readonly VerifiedCanaryPackage[];
  readonly missing: readonly string[];
  /** Current channel owners; callers decide whether moving a tag would regress it. */
  readonly canary: Readonly<Record<string, string | null>>;
}

type ManifestFile = DistributionManifest['files'][number];
interface ExpectedPackage {
  readonly name: string;
  readonly directory: string;
  readonly required: readonly string[];
  readonly files: readonly ManifestFile[];
}

/**
 * Verify published package bytes against an approved shipping manifest before recovery.
 * The caller must authenticate that manifest's builder provenance. Registry provenance
 * metadata is required here; its cryptographic attestation is not verified by this helper.
 * No package or channel is changed. Only an HTTP 404 proves a version absent.
 * Post-publish callers may supply a shared visibility window for individual
 * version/archive 404 reads; initial absence audits omit it and remain immediate.
 *
 * @example
 * const publication = await verifyCanaryNpmPublication(approvedManifest, registry);
 * // Publish only publication.missing, after the other channel's integrity check.
 */
export async function verifyCanaryNpmPublication(
  approvedManifest: DistributionManifest,
  registry: RegistryClient,
  visibility?: CanaryVisibilityWindow
): Promise<CanaryNpmPublication> {
  const manifest = parseDistributionManifest(JSON.stringify(approvedManifest));
  const packages = expectedPackages(manifest);
  const present: VerifiedCanaryPackage[] = [];
  const missing: string[] = [];
  const canary: Record<string, string | null> = {};
  for (const expected of packages) {
    const encodedName = encodeURIComponent(expected.name);
    const versionUrl = `${REGISTRY}/${encodedName}/${encodeURIComponent(manifest.packageVersion)}`;
    const versionResponse = visibility
      ? await visibility.read(
          () => registry.getJson(versionUrl),
          (response) => response.status !== 404
        )
      : await registry.getJson(versionUrl);
    if (versionResponse.status === 404) {
      missing.push(expected.name);
    } else {
      requireSuccess(versionResponse.status, versionUrl);
      const publication = validatePackageMetadata(
        versionResponse.body,
        expected.name,
        manifest.packageVersion
      );
      const archiveResponse = visibility
        ? await visibility.read(
            () => registry.getBytes(publication.tarball),
            (response) => response.status !== 404
          )
        : await registry.getBytes(publication.tarball);
      requireSuccess(archiveResponse.status, publication.tarball);
      await verifyPackageArchive(
        archiveResponse.body,
        publication,
        expected,
        manifest.packageVersion
      );
      present.push(publication);
    }

    const tagsUrl = `${REGISTRY}/-/package/${encodedName}/dist-tags`;
    const tagsResponse = await registry.getJson(tagsUrl);
    if (tagsResponse.status === 404 && versionResponse.status === 404) {
      canary[expected.name] = null;
      continue;
    }
    requireSuccess(tagsResponse.status, tagsUrl);
    const tags = object(tagsResponse.body, `dist-tags for ${expected.name}`);
    for (const [tag, version] of Object.entries(tags)) {
      if (
        typeof version !== 'string' ||
        !isValidSemver(version) ||
        normalizeVersion(version) !== version
      ) {
        throw new Error(
          `Invalid dist-tag ${expected.name}:${tag}: ${JSON.stringify(version)}; expected semver string`
        );
      }
    }
    canary[expected.name] = typeof tags.canary === 'string' ? tags.canary : null;
  }
  return { present, missing, canary };
}

function expectedPackages(manifest: DistributionManifest): readonly ExpectedPackage[] {
  const short = manifest.sourceSha.slice(0, 7);
  const identifier = /^0\d+$/.test(short) ? `g${short}` : short;
  if (
    !/^[0-9a-f]{40}$/.test(manifest.sourceSha) ||
    manifest.dirty ||
    manifest.channel !== 'canary' ||
    manifest.runtimeProfile !== 'shipping' ||
    !isValidSemver(manifest.packageVersion) ||
    normalizeVersion(manifest.packageVersion) !== manifest.packageVersion ||
    !manifest.packageVersion.endsWith(`-canary.${identifier}`)
  ) {
    throw new Error(
      `Invalid canary distribution identity: ${JSON.stringify({
        sourceSha: manifest.sourceSha,
        dirty: manifest.dirty,
        channel: manifest.channel,
        runtimeProfile: manifest.runtimeProfile,
        version: manifest.packageVersion,
      })}; expected clean shipping canary with full source SHA and matching version suffix`
    );
  }
  const descriptions = [
    ...NPM_PLATFORMS.map((platform) => ({
      name: platformPackageName(platform),
      directory: `dist-npm/${platform.os}-${platform.cpu}`,
      required: ['package.json', platform.binary, platform.runtimeBinary],
    })),
    {
      name: MAIN_PACKAGE,
      directory: 'dist-npm/cli',
      required: ['package.json', 'README.md', 'bin/mangostudio.js'],
    },
  ];
  const packages = descriptions.map((description) => ({
    ...description,
    files: manifest.files.filter((file) => file.path.startsWith(`${description.directory}/`)),
  }));
  for (const file of manifest.files.filter((entry) => entry.path.startsWith('dist-npm/'))) {
    if (
      !packages.some((expected) => file.path.startsWith(`${expected.directory}/`)) ||
      file.path.split('/').some((part) => !part || part === '.' || part === '..') ||
      file.path.includes('\\') ||
      file.path.includes('\0')
    ) {
      throw new Error(
        `Invalid npm manifest path: ${file.path}; expected a file in one of the seven publication packages`
      );
    }
  }
  for (const expected of packages) {
    for (const required of expected.required) {
      if (!expected.files.some((file) => file.path === `${expected.directory}/${required}`)) {
        throw new Error(
          `Incomplete npm manifest for ${expected.name}: expected ${expected.directory}/${required}`
        );
      }
    }
  }
  return packages;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}; expected object`);
  }
  return value as Record<string, unknown>;
}

function requireSuccess(status: number, url: string): void {
  if (status !== 200)
    throw new Error(`Registry request ${url}: expected HTTP 200, received ${status}`);
}

function validatePackageMetadata(
  value: unknown,
  name: string,
  version: string
): VerifiedCanaryPackage {
  const metadata = object(value, `${name}@${version} metadata`);
  if (
    metadata.name !== name ||
    metadata.version !== version ||
    metadata._id !== `${name}@${version}`
  ) {
    throw new Error(
      `Registry identity mismatch for ${name}@${version}: received ${JSON.stringify({ name: metadata.name, version: metadata.version, _id: metadata._id })}`
    );
  }
  const dist = object(metadata.dist, `${name}@${version} dist`);
  if (
    typeof dist.integrity !== 'string' ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/.test(dist.integrity) ||
    Buffer.from(dist.integrity.slice(7), 'base64').toString('base64') !== dist.integrity.slice(7)
  ) {
    throw new Error(
      `Invalid integrity for ${name}@${version}: ${JSON.stringify(dist.integrity)}; expected canonical sha512 SRI`
    );
  }
  const unscopedName = name.split('/').at(-1);
  const tarball = `${REGISTRY}/${name}/-/${unscopedName}-${version}.tgz`;
  if (dist.tarball !== tarball) {
    throw new Error(
      `Invalid tarball for ${name}@${version}: ${JSON.stringify(dist.tarball)}; expected ${tarball}`
    );
  }
  const attestations = object(dist.attestations, `${name}@${version} attestations`);
  const provenance = object(attestations.provenance, `${name}@${version} provenance`);
  const provenanceUrl = `${REGISTRY}/-/npm/v1/attestations/${name.replaceAll('/', '%2f')}@${version}`;
  if (attestations.url !== provenanceUrl || provenance.predicateType !== PROVENANCE_PREDICATE) {
    throw new Error(
      `Invalid provenance metadata for ${name}@${version}: ${JSON.stringify(attestations)}; expected ${provenanceUrl} with ${PROVENANCE_PREDICATE}`
    );
  }
  return { name, integrity: dist.integrity, tarball, provenanceUrl };
}

async function verifyPackageArchive(
  bytes: Uint8Array,
  publication: VerifiedCanaryPackage,
  expected: ExpectedPackage,
  version: string
): Promise<void> {
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (integrity !== publication.integrity) {
    throw new Error(
      `Registry archive integrity mismatch for ${expected.name}: expected ${publication.integrity}, received ${integrity}`
    );
  }
  const maxOutputLength =
    expected.files.reduce((total, file) => total + file.size, 0) + 1024 * 1024;
  let tar: Buffer;
  try {
    tar = gunzipSync(bytes, { maxOutputLength });
  } catch (cause) {
    throw new Error(`Invalid npm archive for ${expected.name}: expected bounded gzip tar`, {
      cause,
    });
  }
  assertRegularTar(tar, expected.name);
  const entries = await new Bun.Archive(tar).files();
  const expectedFiles = new Map(
    expected.files.map((file) => [
      `package/${file.path.slice(expected.directory.length + 1)}`,
      file,
    ])
  );
  const receivedPaths = [...entries.keys()].sort();
  const expectedPaths = [...expectedFiles.keys()].sort();
  if (JSON.stringify(receivedPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error(
      `Registry archive paths mismatch for ${expected.name}: expected ${JSON.stringify(expectedPaths)}, received ${JSON.stringify(receivedPaths)}`
    );
  }
  for (const [path, file] of expectedFiles) {
    const entry = entries.get(path);
    if (!entry) throw new Error(`Missing npm archive entry for ${expected.name}: ${path}`);
    const content = await entry.bytes();
    const digest = createHash('sha256').update(content).digest('hex');
    if (content.byteLength !== file.size || digest !== file.sha256) {
      throw new Error(
        `Published bytes mismatch for ${expected.name} ${path}: expected size ${file.size} sha256 ${file.sha256}, received size ${content.byteLength} sha256 ${digest}`
      );
    }
    if (path === 'package/package.json') {
      const text = Buffer.from(content).toString('utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (cause) {
        throw new Error(
          `Invalid packaged manifest for ${expected.name}@${version}: expected JSON object in package/package.json; received ${JSON.stringify(text.slice(0, 160))}`,
          { cause }
        );
      }
      const packaged = object(parsed, `${expected.name} package.json`);
      if (packaged.name !== expected.name || packaged.version !== version) {
        throw new Error(
          `Packaged identity mismatch: expected ${expected.name}@${version}, received ${JSON.stringify(packaged)}`
        );
      }
    }
  }
}

// Bun.Archive.files() omits symlinks and directories. Reject unsupported tar
// entries before trusting its listing, including duplicate members and hidden links.
function assertRegularTar(tar: Buffer, name: string): void {
  const seen = new Set<string>();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (!tar.subarray(offset).every((byte) => byte === 0)) {
        throw new Error(`Invalid npm tar for ${name}: expected zero padding after end marker`);
      }
      return;
    }
    // ASCII decoding masks bit7. Validate the complete raw numeric fields,
    // including padding, before interpreting their octal values.
    for (const [field, start, end] of [
      ['checksum', 148, 156],
      ['size', 124, 136],
      ['mode', 100, 108],
    ] as const) {
      const bytes = header.subarray(start, end);
      if (bytes.some((byte) => byte !== 0 && byte !== 32 && (byte < 48 || byte > 55))) {
        throw new Error(
          `Invalid npm tar ${field} field for ${name}: expected raw octal digits with NUL/space padding; received ${bytes.toString('hex')}`
        );
      }
    }
    const checksumField = header.subarray(148, 156).toString('latin1').replace(/\0.*$/s, '').trim();
    const recordedChecksum = /^[0-7]+$/.test(checksumField)
      ? Number.parseInt(checksumField, 8)
      : Number.NaN;
    const actualChecksum = header.reduce(
      (total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte),
      0
    );
    if (recordedChecksum !== actualChecksum)
      throw new Error(
        `Invalid npm tar for ${name}: expected valid tar header checksum ${actualChecksum}, received ${checksumField}`
      );
    const path = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
    const sizeField = header.subarray(124, 136).toString('latin1').replace(/\0.*$/s, '').trim();
    const size = /^[0-7]+$/.test(sizeField) ? Number.parseInt(sizeField, 8) : Number.NaN;
    const modeField = header.subarray(100, 108).toString('latin1').replace(/\0.*$/s, '').trim();
    const mode = /^[0-7]+$/.test(modeField) ? Number.parseInt(modeField, 8) : Number.NaN;
    if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o777) {
      throw new Error(
        `Invalid npm tar permissions for ${name} ${path}: ${modeField}; expected ordinary file permissions without special bits`
      );
    }
    if (
      /^@mangostudio\/cli-(linux|darwin)-/.test(name) &&
      ['package/mangostudio', 'package/mangostudio-runtime'].includes(path) &&
      mode !== 0o755
    ) {
      throw new Error(
        `Invalid npm tar permissions for ${name} ${path}: ${modeField}; expected executable Unix binary with normalized mode 0755`
      );
    }
    const type = header[156];
    if (
      prefix ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      (type !== 0 && type !== 48 && type !== 53) ||
      (type === 53 && size !== 0) ||
      !path.startsWith('package/') ||
      path.includes('\\') ||
      path
        .replace(/\/$/, '')
        .split('/')
        .some((part) => !part || part === '.' || part === '..') ||
      seen.has(path)
    ) {
      throw new Error(
        `Invalid npm tar entry for ${name}: path=${JSON.stringify(path)} type=${type} size=${sizeField}; expected unique regular package file or directory`
      );
    }
    seen.add(path);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (offset > tar.length)
      throw new Error(`Truncated npm tar for ${name}: entry ${path} exceeds archive length`);
  }
  throw new Error(`Invalid npm tar for ${name}: expected end marker`);
}
