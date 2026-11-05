import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import type { RegistryClient, RegistryResponse } from '../lib/canary-publication';
import {
  auditCanaryPublication,
  type CanaryPublicationAuditDependencies,
  type CanaryPublicationAuditGitHub,
  parseCanaryApprovalOrigin,
} from '../lib/canary-publication-audit';
import type { CanaryReleaseExpectation, CanaryReleaseResponse } from '../lib/canary-release';
import type { CanaryTagAncestry } from '../lib/canary-tags';
import type { DistributionManifest } from '../lib/distribution-manifest';
import { MAIN_PACKAGE, NPM_PLATFORMS, platformPackageName } from '../lib/npm-pack';
import type { NpmCommandResult } from '../lib/npm-publish';
import { canaryReleaseVersion } from '../lib/release-version';
import {
  CanaryAuditReadRunner,
  runAuditCanaryPublicationCli,
} from '../release/audit-canary-publication';
import type { CanaryTagProcess } from '../release/promote-canary-tags';

const REPOSITORY = 'owner/repo';
const SOURCE = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const NEW = 'c'.repeat(40);
const DIVERGED = 'd'.repeat(40);
const VERSION = '1.2.3-canary.aaaaaaa';
const OLD_VERSION = '1.2.2-canary.bbbbbbb';
const NEW_VERSION = '1.2.4-canary.ccccccc';
const TAG = `v${VERSION}`;
const NAMES = [...NPM_PLATFORMS.map(platformPackageName), MAIN_PACKAGE];

function versionUrl(name: string): string {
  return `https://registry.npmjs.org/${encodeURIComponent(name)}/${VERSION}`;
}
function digest(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function releaseRecord(
  tag: string,
  id: number,
  source: string,
  draft = false
): Record<string, unknown> {
  return {
    id,
    tag_name: tag,
    target_commitish: source,
    draft,
    prerelease: true,
    immutable: !draft,
    html_url: `https://github.com/${REPOSITORY}/releases/tag/${tag}`,
    url: `https://api.github.com/repos/${REPOSITORY}/releases/${id}`,
  };
}

class AuditRegistry implements RegistryClient {
  readonly versions = new Map<string, RegistryResponse<unknown>>();
  readonly archives = new Map<string, RegistryResponse<Uint8Array>>();
  readonly owners = new Map<string, string | null>();
  readonly calls: string[] = [];
  getJson(url: string): Promise<RegistryResponse<unknown>> {
    this.calls.push(url);
    const prefix = 'https://registry.npmjs.org/-/package/';
    if (url.startsWith(prefix) && url.endsWith('/dist-tags')) {
      const name = decodeURIComponent(url.slice(prefix.length, -'/dist-tags'.length));
      if (!this.owners.has(name)) throw new Error(`Unexpected audit registry owner ${name}`);
      const owner = this.owners.get(name);
      return Promise.resolve({
        status: 200,
        body: { latest: '1.2.2', ...(owner === null ? {} : { canary: owner }) },
      });
    }
    const response = this.versions.get(url);
    if (!response) throw new Error(`Unexpected audit registry version ${url}`);
    return Promise.resolve(response);
  }
  getBytes(url: string): Promise<RegistryResponse<Uint8Array>> {
    this.calls.push(url);
    const response = this.archives.get(url);
    if (!response) throw new Error(`Unexpected audit registry archive ${url}`);
    return Promise.resolve(response);
  }
}

class AuditGitHub implements CanaryPublicationAuditGitHub {
  release: CanaryReleaseResponse = { status: 200, body: releaseRecord(TAG, 17, SOURCE) };
  readonly tags = new Map<string, CanaryReleaseResponse>([
    [TAG, { status: 200, body: SOURCE }],
    [`v${OLD_VERSION}`, { status: 200, body: OLD }],
    [`v${NEW_VERSION}`, { status: 200, body: NEW }],
  ]);
  readonly tagSequences = new Map<string, CanaryReleaseResponse[]>();
  assets: unknown = [];
  releases: unknown = [releaseRecord(TAG, 17, SOURCE)];
  readonly failures = new Map<string, Error>();
  readonly calls: string[] = [];
  getRelease(tag: string): Promise<CanaryReleaseResponse> {
    this.record(`release:${tag}`);
    if (tag !== TAG) throw new Error(`Unexpected audit release ${tag}`);
    return Promise.resolve(this.release);
  }
  resolveTag(tag: string): Promise<CanaryReleaseResponse> {
    this.record(`tag:${tag}`);
    const response = this.tagSequences.get(tag)?.shift() ?? this.tags.get(tag);
    if (!response) throw new Error(`Unexpected audit tag ${tag}`);
    return Promise.resolve(response);
  }
  listAssets(id: number): Promise<readonly unknown[]> {
    this.record(`assets:${id}`);
    if (id !== 17) throw new Error(`Unexpected audit asset release ${id}`);
    return Promise.resolve(this.assets as readonly unknown[]);
  }
  list(path: string): Promise<readonly unknown[]> {
    this.record(`list:${path}`);
    if (path !== `repos/${REPOSITORY}/releases?per_page=100`)
      throw new Error(`Unexpected audit list ${path}`);
    return Promise.resolve(this.releases as readonly unknown[]);
  }
  private record(call: string): void {
    this.calls.push(call);
    const failure = this.failures.get(call);
    if (failure) throw failure;
  }
}

class AuditAncestry implements CanaryTagAncestry {
  readonly calls: string[] = [];
  readonly commits = new Map([
    ['aaaaaaa', SOURCE],
    ['bbbbbbb', OLD],
    ['ccccccc', NEW],
    ['ddddddd', DIVERGED],
  ]);
  readonly relations = new Map<string, 'ahead' | 'behind' | 'identical' | 'diverged'>([
    [`${OLD}...${SOURCE}`, 'ahead'],
    [`${SOURCE}...${OLD}`, 'behind'],
    [`${SOURCE}...${NEW}`, 'ahead'],
    [`${NEW}...${SOURCE}`, 'behind'],
    [`${DIVERGED}...${SOURCE}`, 'diverged'],
    [`${SOURCE}...${DIVERGED}`, 'diverged'],
  ]);
  resolveCommit(prefix: string): Promise<string> {
    this.calls.push(`resolve:${prefix}`);
    const source = this.commits.get(prefix);
    if (!source) throw new Error(`Unexpected audit source prefix ${prefix}`);
    return Promise.resolve(source);
  }
  compare(base: string, head: string): Promise<'ahead' | 'behind' | 'identical' | 'diverged'> {
    this.calls.push(`compare:${base}...${head}`);
    if (base === head) return Promise.resolve('identical');
    const relation = this.relations.get(`${base}...${head}`);
    if (!relation) throw new Error(`Unexpected audit comparison ${base}...${head}`);
    return Promise.resolve(relation);
  }
}

class AuditProcess implements CanaryTagProcess {
  readonly calls: (readonly string[])[] = [];
  run(command: readonly string[]): Promise<NpmCommandResult> {
    this.calls.push([...command]);
    return Promise.resolve({ exitCode: 0, stdout: 'fixture-json', stderr: '' });
  }
}

interface Fixture {
  readonly manifest: DistributionManifest;
  readonly expected: CanaryReleaseExpectation;
  readonly registry: AuditRegistry;
  readonly github: AuditGitHub;
  readonly ancestry: AuditAncestry;
  readonly dependencies: CanaryPublicationAuditDependencies;
}

async function fixture(): Promise<Fixture> {
  const registry = new AuditRegistry();
  const files: DistributionManifest['files'][number][] = [];
  const packages = [
    ...NPM_PLATFORMS.map((platform) => ({
      name: platformPackageName(platform),
      directory: `dist-npm/${platform.os}-${platform.cpu}`,
      files: [platform.binary, platform.runtimeBinary],
    })),
    { name: MAIN_PACKAGE, directory: 'dist-npm/cli', files: ['README.md', 'bin/mangostudio.js'] },
  ];
  for (const pkg of packages) {
    const contents: Record<string, string> = {
      'package/package.json': JSON.stringify({ name: pkg.name, version: VERSION }),
    };
    for (const file of pkg.files) contents[`package/${file}`] = `${pkg.name} approved ${file}`;
    for (const [path, content] of Object.entries(contents))
      files.push({
        path: `${pkg.directory}/${path.slice(8)}`,
        size: Buffer.byteLength(content),
        sha256: digest(content),
      });
    let bytes: Uint8Array = await new Bun.Archive(contents, { compress: 'gzip' }).bytes();
    if (/^@mangostudio\/cli-(linux|darwin)-/.test(pkg.name)) bytes = executableArchive(bytes);
    const tarball = `https://registry.npmjs.org/${pkg.name}/-/${pkg.name.split('/').at(-1)}-${VERSION}.tgz`;
    registry.archives.set(tarball, { status: 200, body: bytes });
    registry.versions.set(versionUrl(pkg.name), {
      status: 200,
      body: {
        name: pkg.name,
        version: VERSION,
        _id: `${pkg.name}@${VERSION}`,
        dist: {
          tarball,
          integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
          attestations: {
            url: `https://registry.npmjs.org/-/npm/v1/attestations/${pkg.name.replaceAll('/', '%2f')}@${VERSION}`,
            provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
          },
        },
      },
    });
    registry.owners.set(pkg.name, VERSION);
  }
  const manifest: DistributionManifest = {
    schemaVersion: 5,
    sourceSha: SOURCE,
    packageVersion: VERSION,
    dirty: false,
    channel: 'canary',
    runtimeProfile: 'shipping',
    bunVersion: '1.4.4',
    bunRevision: 'e'.repeat(40),
    targets: [],
    files,
  };
  const expected: CanaryReleaseExpectation = {
    repository: REPOSITORY,
    sourceSha: SOURCE,
    version: VERSION,
    assets: [
      { name: 'binary.tar.gz', size: 16, sha256: digest('approved archive') },
      { name: 'promotion.json', size: 17, sha256: digest('approved evidence') },
    ],
  };
  const github = new AuditGitHub();
  github.assets = expected.assets.map((asset, index) => ({
    id: 31 + index,
    name: asset.name,
    size: asset.size,
    state: 'uploaded',
    digest: `sha256:${asset.sha256}`,
  }));
  const ancestry = new AuditAncestry();
  return {
    manifest,
    expected,
    registry,
    github,
    ancestry,
    dependencies: { registry, github, ancestry },
  };
}

function executableArchive(bytes: Uint8Array): Uint8Array {
  const tar = gunzipSync(bytes);
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    const path = header.subarray(0, 100).toString().replace(/\0.*$/s, '');
    const size =
      Number.parseInt(header.subarray(124, 136).toString().replace(/\0.*$/s, '').trim(), 8) || 0;
    if (['package/mangostudio', 'package/mangostudio-runtime'].includes(path)) {
      header.write('0000755\0', 100, 8, 'ascii');
      header.fill(32, 148, 156);
      header.write(
        `${header
          .reduce((sum, byte) => sum + byte, 0)
          .toString(8)
          .padStart(6, '0')}\0 `,
        148,
        8,
        'ascii'
      );
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return gzipSync(tar);
}
function owners(registry: AuditRegistry, version: string | null): void {
  for (const name of NAMES) registry.owners.set(name, version);
}
function missingPackages(registry: AuditRegistry, names: readonly string[]): void {
  for (const name of names) registry.versions.set(versionUrl(name), { status: 404, body: {} });
}

function producedCanaryVersion(rootVersion: string, source: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'fix-canary-publication-audit-producer-'));
  try {
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ version: rootVersion }));
    return canaryReleaseVersion(source, directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('fresh canary publication decisions', () => {
  test('only complete actual npm/archive and GitHub asset receipts allow selected-owner noop', async () => {
    const { manifest, expected, dependencies } = await fixture();
    const audit = await auditCanaryPublication(manifest, expected, dependencies);
    expect(audit.decision).toBe('noop');
    expect(audit.reason).toBe('already-complete');
    expect(audit.needed).toEqual({ npm: false, packages: [], tags: [], github: false });
    expect(audit.receipts.npm.present.map((pkg) => pkg.name)).toEqual(NAMES);
    expect(audit.receipts.npm.present.every((pkg) => pkg.integrity.startsWith('sha512-'))).toBe(
      true
    );
    expect(audit.receipts.github).toEqual({
      state: 'complete',
      releaseId: 17,
      present: expected.assets.map((asset) => asset.name),
      missing: [],
    });
    expect(audit.receipts.publishedCanaries[0]?.sourceSha).toBe(SOURCE);
  });
  test.each([
    ['v0.1.0-canary', false, false],
    ['v0.1.0-canary', false, true],
    ['v0.1.1-canary', true, false],
    ['v0.1.1-canary', true, true],
  ] as const)(
    'legacy rolling alias %s (immutable=%s, missing wrapper=%s) does not change publication decisions',
    async (tag, immutable, missingWrapper) => {
      const { manifest, expected, registry, github, dependencies } = await fixture();
      github.releases = [
        ...(github.releases as unknown[]),
        { ...releaseRecord(tag, 18, OLD), immutable },
      ];
      if (missingWrapper) missingPackages(registry, [MAIN_PACKAGE]);
      const audit = await auditCanaryPublication(manifest, expected, dependencies);
      expect(audit.decision).toBe(missingWrapper ? 'publish' : 'noop');
      expect(audit.needed.packages).toEqual(missingWrapper ? [MAIN_PACKAGE] : []);
      expect(audit.receipts.publishedCanaries.map((release) => release.tag)).toEqual([TAG]);
      expect(github.calls).not.toContain(`tag:${tag}`);
    }
  );
  test('wrapper existence cannot hide six missing platform packages', async () => {
    const { manifest, expected, registry, dependencies } = await fixture();
    missingPackages(registry, NAMES.slice(0, 6));
    const audit = await auditCanaryPublication(manifest, expected, dependencies);
    expect(audit.decision).toBe('publish');
    expect(audit.needed).toEqual({
      npm: true,
      packages: NAMES.slice(0, 6),
      tags: [],
      github: false,
    });
    expect(audit.receipts.npm.present.map((pkg) => pkg.name)).toEqual([MAIN_PACKAGE]);
  });
  test('a missing wrapper also prevents complete noop', async () => {
    const { manifest, expected, registry, dependencies } = await fixture();
    missingPackages(registry, [MAIN_PACKAGE]);
    const audit = await auditCanaryPublication(manifest, expected, dependencies);
    expect(audit.decision).toBe('publish');
    expect(audit.needed.packages).toEqual([MAIN_PACKAGE]);
  });
  test('matching draft subsets need GitHub recovery even if every package and tag is complete', async () => {
    const { manifest, expected, github, dependencies } = await fixture();
    github.release = { status: 200, body: releaseRecord(TAG, 17, SOURCE, true) };
    github.releases = [github.release.body];
    github.assets = (github.assets as readonly unknown[]).slice(0, 1);
    const audit = await auditCanaryPublication(manifest, expected, dependencies);
    expect(audit.decision).toBe('publish');
    expect(audit.needed).toEqual({ npm: false, packages: [], tags: [], github: true });
    expect(audit.receipts.github.missing.map((asset) => asset.name)).toEqual(['promotion.json']);
  });
  test('public incomplete releases fail with immutable recovery instructions', async () => {
    const { manifest, expected, github, dependencies } = await fixture();
    github.assets = (github.assets as readonly unknown[]).slice(0, 1);
    await expect(auditCanaryPublication(manifest, expected, dependencies)).rejects.toThrow(
      'publish the next version instead'
    );
  });
  test('new publication is authorized only after fresh owner planning and full release history', async () => {
    const { manifest, expected, registry, github, ancestry, dependencies } = await fixture();
    missingPackages(registry, NAMES);
    owners(registry, OLD_VERSION);
    github.release = { status: 404, body: {} };
    github.tags.set(TAG, { status: 404, body: {} });
    github.releases = [releaseRecord(`v${OLD_VERSION}`, 18, OLD)];
    const audit = await auditCanaryPublication(manifest, expected, dependencies);
    expect(audit.reason).toBe('new-publication');
    expect(audit.needed).toEqual({ npm: true, packages: NAMES, tags: NAMES, github: true });
    expect(ancestry.calls).toContain('resolve:bbbbbbb');
    expect(audit.receipts.publishedCanaries[0]?.relation).toBe('ancestor');
  });
  test('a complete version with all seven newer owners is a superseded noop using a peeled full tag SHA', async () => {
    const { manifest, expected, registry, github, ancestry, dependencies } = await fixture();
    owners(registry, NEW_VERSION);
    github.releases = [releaseRecord(TAG, 17, SOURCE), releaseRecord(`v${NEW_VERSION}`, 18, NEW)];
    const audit = await auditCanaryPublication(manifest, expected, dependencies);
    expect(audit.decision).toBe('noop');
    expect(audit.reason).toBe('superseded');
    expect(audit.supersededBy).toEqual({ version: NEW_VERSION, sourceSha: NEW });
    expect(audit.needed).toEqual({ npm: false, packages: [], tags: [], github: false });
    expect(github.calls).toContain(`tag:v${NEW_VERSION}`);
    expect(ancestry.calls).toContain(`compare:${SOURCE}...${NEW}`);
  });
  test('a complete selected-owner version remains a no-op when a later GitHub version already exists', async () => {
    const { manifest, expected, github, dependencies } = await fixture();
    github.releases = [releaseRecord(TAG, 17, SOURCE), releaseRecord(`v${NEW_VERSION}`, 18, NEW)];
    expect((await auditCanaryPublication(manifest, expected, dependencies)).reason).toBe(
      'already-complete'
    );
  });
  test.each(['npm', 'github'])(
    'unanimous newer owners cannot hide incomplete selected %s publication',
    async (channel) => {
      const { manifest, expected, registry, github, dependencies } = await fixture();
      owners(registry, NEW_VERSION);
      if (channel === 'npm') missingPackages(registry, [MAIN_PACKAGE]);
      else {
        github.release = { status: 404, body: {} };
        github.releases = [];
      }
      await expect(auditCanaryPublication(manifest, expected, dependencies)).rejects.toThrow(
        'expected selected source ahead of owner'
      );
    }
  );
  test('newer supersession requires an actual full peeled tag, not just the version suffix', async () => {
    const { manifest, expected, registry, github, dependencies } = await fixture();
    owners(registry, NEW_VERSION);
    github.tags.set(`v${NEW_VERSION}`, { status: 200, body: DIVERGED });
    await expect(auditCanaryPublication(manifest, expected, dependencies)).rejects.toThrow(
      'expected HTTP200 full commit SHA with prefix ccccccc'
    );
  });
  test('an absent newer tag cannot prove supersession or authorize backwards writes', async () => {
    const { manifest, expected, registry, github, dependencies } = await fixture();
    owners(registry, NEW_VERSION);
    github.tags.set(`v${NEW_VERSION}`, { status: 404, body: {} });
    await expect(auditCanaryPublication(manifest, expected, dependencies)).rejects.toThrow(
      'expected selected source ahead of owner'
    );
  });
  test('mixed selected/ancestor owners recover forward instead of becoming a noop', async () => {
    const { manifest, expected, registry, dependencies } = await fixture();
    registry.owners.set(MAIN_PACKAGE, OLD_VERSION);
    const audit = await auditCanaryPublication(manifest, expected, dependencies);
    expect(audit.decision).toBe('publish');
    expect(audit.reason).toBe('tag-recovery');
    expect(audit.needed).toEqual({ npm: true, packages: [], tags: [MAIN_PACKAGE], github: false });
  });
  test('mixed owners containing a newer source block stale retry mutations', async () => {
    const { manifest, expected, registry, dependencies } = await fixture();
    registry.owners.set(MAIN_PACKAGE, NEW_VERSION);
    await expect(auditCanaryPublication(manifest, expected, dependencies)).rejects.toThrow(
      'expected selected source ahead of owner'
    );
  });
  test('unanimous older owners with an existing full tag recover forward', async () => {
    const { manifest, expected, registry, dependencies } = await fixture();
    owners(registry, OLD_VERSION);
    const audit = await auditCanaryPublication(manifest, expected, dependencies);
    expect(audit.reason).toBe('tag-recovery');
    expect(audit.needed.tags).toEqual(NAMES);
  });
  test('unanimous older owners recover tags even when the old GitHub tag was pruned', async () => {
    const { manifest, expected, registry, github, dependencies } = await fixture();
    owners(registry, OLD_VERSION);
    github.tags.set(`v${OLD_VERSION}`, { status: 404, body: {} });
    const audit = await auditCanaryPublication(manifest, expected, dependencies);
    expect(audit.reason).toBe('tag-recovery');
    expect(audit.needed.tags).toEqual(NAMES);
  });
  test.each(['newer', 'diverged'])(
    'a published %s GitHub source blocks any selected mutation',
    async (kind) => {
      const { manifest, expected, registry, github, dependencies } = await fixture();
      owners(registry, OLD_VERSION);
      const source = kind === 'newer' ? NEW : DIVERGED;
      const version = kind === 'newer' ? NEW_VERSION : '1.2.4-canary.ddddddd';
      github.tags.set(`v${version}`, { status: 200, body: source });
      github.releases = [releaseRecord(TAG, 17, SOURCE), releaseRecord(`v${version}`, 18, source)];
      await expect(auditCanaryPublication(manifest, expected, dependencies)).rejects.toThrow(
        'expected selected source to equal or descend from every published canary'
      );
    }
  );
  test('stable, protocol and draft releases never supply a canary ordering verdict', async () => {
    const { manifest, expected, github, ancestry, dependencies } = await fixture();
    github.releases = [
      releaseRecord(TAG, 17, SOURCE),
      { tag_name: 'v9.9.9', draft: false },
      { tag_name: 'protocol-v1.2.3-canary.unproven', draft: false },
      { tag_name: 'canary', draft: true },
    ];
    expect((await auditCanaryPublication(manifest, expected, dependencies)).decision).toBe('noop');
    expect(ancestry.calls).toEqual([]);
  });
  test('producer prerelease canary roots are accepted in published history', async () => {
    const { manifest, expected, github, dependencies } = await fixture();
    const version = producedCanaryVersion('1.2.2-rc.0', OLD);
    expect(version).toBe('1.2.2-rc.0-canary.bbbbbbb');
    github.releases = [releaseRecord(`v${version}`, 18, OLD)];
    github.tags.set(`v${version}`, { status: 200, body: OLD });
    const audit = await auditCanaryPublication(manifest, expected, dependencies);
    expect(audit.reason).toBe('already-complete');
    expect(audit.receipts.publishedCanaries[0]?.version).toBe(version);
  });
  test('producer prerelease canary roots can unanimously supersede complete selected versions', async () => {
    const { manifest, expected, registry, github, dependencies } = await fixture();
    const version = producedCanaryVersion('1.2.4-rc.0', NEW);
    expect(version).toBe('1.2.4-rc.0-canary.ccccccc');
    owners(registry, version);
    github.releases = [releaseRecord(TAG, 17, SOURCE), releaseRecord(`v${version}`, 18, NEW)];
    github.tags.set(`v${version}`, { status: 200, body: NEW });
    const audit = await auditCanaryPublication(manifest, expected, dependencies);
    expect(audit.reason).toBe('superseded');
    expect(audit.supersededBy).toEqual({ version, sourceSha: NEW });
  });
  test('valid whole SemVer does not excuse a noncanonical producer root', async () => {
    const { manifest, expected, github, dependencies } = await fixture();
    const tag = 'v1.2.3--canary.bbbbbbb';
    github.releases = [releaseRecord(tag, 18, OLD)];
    github.tags.set(tag, { status: 200, body: OLD });
    await expect(auditCanaryPublication(manifest, expected, dependencies)).rejects.toThrow(
      'expected canonical v<version>-canary.<sha7>'
    );
  });
  test.each(['canary', 'v1.2.3-canary.bad', 'v1.2.3-canary.0000000'])(
    'published canary prefix %s must be canonical and source-proven',
    async (tag) => {
      const { manifest, expected, github, dependencies } = await fixture();
      github.releases = [releaseRecord(tag, 18, OLD)];
      await expect(auditCanaryPublication(manifest, expected, dependencies)).rejects.toThrow(
        'expected canonical v<version>-canary.<sha7>'
      );
    }
  );
  test.each([
    { immutable: false },
    { prerelease: false },
    { id: 0 },
    { html_url: 'https://github.com/other/repo/releases/tag/tag' },
  ])('rejects unproven published canary metadata %j', async (mutation) => {
    const { manifest, expected, github, dependencies } = await fixture();
    github.releases = [{ ...releaseRecord(TAG, 17, SOURCE), ...mutation }];
    await expect(auditCanaryPublication(manifest, expected, dependencies)).rejects.toThrow(
      'expected unique immutable pre-release'
    );
  });
  test('distinct published sources cannot use an identical ancestry verdict', async () => {
    const { manifest, expected, github, ancestry, dependencies } = await fixture();
    github.releases = [releaseRecord(`v${OLD_VERSION}`, 18, OLD)];
    ancestry.relations.set(`${OLD}...${SOURCE}`, 'identical');
    await expect(auditCanaryPublication(manifest, expected, dependencies)).rejects.toThrow(
      'expected ahead/behind/diverged for distinct sources'
    );
  });
  test('numeric source identifiers retain their canonical git prefix', async () => {
    const { manifest, expected, github, ancestry, dependencies } = await fixture();
    const source = `0123456${'b'.repeat(33)}`;
    const tag = 'v1.2.2-canary.g0123456';
    github.releases = [releaseRecord(tag, 18, source)];
    github.tags.set(tag, { status: 200, body: source });
    ancestry.relations.set(`${source}...${SOURCE}`, 'ahead');
    expect(
      (await auditCanaryPublication(manifest, expected, dependencies)).receipts.publishedCanaries[0]
        ?.relation
    ).toBe('ancestor');
  });
  test.each([null, [null]].map((releases) => [releases]))(
    'malformed release history %j cannot establish completeness',
    async (releases) => {
      const { manifest, expected, github, dependencies } = await fixture();
      github.releases = releases;
      await expect(auditCanaryPublication(manifest, expected, dependencies)).rejects.toThrow(
        /expected complete release array|expected object/
      );
    }
  );
  test('tag authentication errors do not become absent or superseded results', async () => {
    const { manifest, expected, registry, github, dependencies } = await fixture();
    owners(registry, NEW_VERSION);
    github.tags.set(`v${NEW_VERSION}`, { status: 403, body: {} });
    await expect(auditCanaryPublication(manifest, expected, dependencies)).rejects.toThrow(
      'expected HTTP200 full commit SHA'
    );
  });
  test('duplicate release identities cannot substitute for a complete history read', async () => {
    const { manifest, expected, github, dependencies } = await fixture();
    github.releases = [releaseRecord(TAG, 17, SOURCE), releaseRecord(TAG, 17, SOURCE)];
    await expect(auditCanaryPublication(manifest, expected, dependencies)).rejects.toThrow(
      'expected unique immutable pre-release'
    );
  });
  test('incomplete history and registry/auth failures never become complete noop', async () => {
    const first = await fixture();
    first.github.failures.set(
      `list:repos/${REPOSITORY}/releases?per_page=100`,
      new Error('fixture incomplete GitHub pagination')
    );
    await expect(
      auditCanaryPublication(first.manifest, first.expected, first.dependencies)
    ).rejects.toThrow('fixture incomplete GitHub pagination');
    const second = await fixture();
    second.registry.versions.set(versionUrl(MAIN_PACKAGE), { status: 403, body: {} });
    await expect(
      auditCanaryPublication(second.manifest, second.expected, second.dependencies)
    ).rejects.toThrow('expected HTTP 200, received 403');
    const third = await fixture();
    third.github.release = { status: 403, body: {} };
    await expect(
      auditCanaryPublication(third.manifest, third.expected, third.dependencies)
    ).rejects.toThrow('expected HTTP 200; received 403');
  });
  test('corrupt package and release bytes cannot hide behind matching names and selected tags', async () => {
    const first = await fixture();
    const archive = [...first.registry.archives.entries()][0];
    if (!archive) throw new Error('Fixture lacks archive');
    first.registry.archives.set(archive[0], { status: 200, body: new Uint8Array([1, 2, 3]) });
    await expect(
      auditCanaryPublication(first.manifest, first.expected, first.dependencies)
    ).rejects.toThrow('Registry archive integrity mismatch');
    const second = await fixture();
    const asset = (second.github.assets as Record<string, unknown>[])[0];
    if (!asset) throw new Error('Fixture lacks release asset');
    asset.digest = `sha256:${'f'.repeat(64)}`;
    await expect(
      auditCanaryPublication(second.manifest, second.expected, second.dependencies)
    ).rejects.toThrow('Published asset mismatch');
  });
  test('selected source/expected release mismatch fails before network reads', async () => {
    const { manifest, expected, registry, github, dependencies } = await fixture();
    await expect(
      auditCanaryPublication(manifest, { ...expected, sourceSha: OLD }, dependencies)
    ).rejects.toThrow('Canary audit identity mismatch');
    expect(registry.calls).toEqual([]);
    expect(github.calls).toEqual([]);
  });
  test('a same-source version alias is not a superseding version', async () => {
    const { manifest, expected, registry, github, dependencies } = await fixture();
    const alias = '1.2.2-canary.aaaaaaa';
    owners(registry, alias);
    github.tags.set(`v${alias}`, { status: 200, body: SOURCE });
    await expect(auditCanaryPublication(manifest, expected, dependencies)).rejects.toThrow(
      'expected a strict descendant or ancestor'
    );
  });
});

describe('fresh CI approval cannot replace deleted original approval evidence', () => {
  test('partial selected npm packages cannot be filled from a fresh CI artifact set', async () => {
    const { manifest, expected, registry, github, dependencies } = await fixture();
    missingPackages(registry, NAMES.slice(3));
    owners(registry, OLD_VERSION);
    for (const name of NAMES.slice(0, 3)) registry.owners.set(name, VERSION);
    github.release = { status: 404, body: {} };
    github.tags.set(TAG, { status: 404, body: {} });
    github.releases = [];
    await expect(auditCanaryPublication(manifest, expected, dependencies, 'ci')).rejects.toThrow(
      'original approval evidence'
    );
  });
  test('a matching leftover selected tag is a prior side effect even without packages or release', async () => {
    const { manifest, expected, registry, github, dependencies } = await fixture();
    missingPackages(registry, NAMES);
    owners(registry, OLD_VERSION);
    github.release = { status: 404, body: {} };
    github.tags.set(TAG, { status: 200, body: SOURCE });
    github.releases = [];
    await expect(auditCanaryPublication(manifest, expected, dependencies, 'ci')).rejects.toThrow(
      'original approval evidence'
    );
  });
});

describe('approval origin parsing and recovery policy', () => {
  test.each(['ci', 'actions', 'release'] as const)(
    'accepts only the verified acquisition label %s',
    (origin) => {
      expect(parseCanaryApprovalOrigin(origin)).toBe(origin);
    }
  );
  test('origin stays optional for independent read-only callers', () => {
    expect(parseCanaryApprovalOrigin(undefined)).toBe(undefined);
  });
  test.each(['CI', '', 'fresh', null, 42, {}].map((origin) => [origin]))(
    'rejects invalid approval origin %j',
    (origin) => {
      expect(() => parseCanaryApprovalOrigin(origin)).toThrow('expected ci | actions | release');
    }
  );
  test('fresh CI may approve an untouched selected version while older versions exist', async () => {
    const { manifest, expected, registry, github, dependencies } = await fixture();
    missingPackages(registry, NAMES);
    owners(registry, OLD_VERSION);
    github.release = { status: 404, body: {} };
    github.tags.set(TAG, { status: 404, body: {} });
    github.releases = [releaseRecord(`v${OLD_VERSION}`, 18, OLD)];
    const audit = await auditCanaryPublication(manifest, expected, dependencies, 'ci');
    expect(audit.decision).toBe('publish');
    expect(audit.reason).toBe('new-publication');
    expect(audit.needed.packages).toEqual(NAMES);
  });
  test.each(['actions', 'release'] as const)(
    'authenticated %s approval can resume matching partial bytes',
    async (origin) => {
      const { manifest, expected, registry, github, dependencies } = await fixture();
      missingPackages(registry, NAMES.slice(3));
      owners(registry, OLD_VERSION);
      for (const name of NAMES.slice(0, 3)) registry.owners.set(name, VERSION);
      github.release = { status: 404, body: {} };
      github.tags.set(TAG, { status: 404, body: {} });
      github.releases = [];
      const audit = await auditCanaryPublication(manifest, expected, dependencies, origin);
      expect(audit.decision).toBe('publish');
      expect(audit.needed.packages).toEqual(NAMES.slice(3));
    }
  );
  test('a leftover draft alone blocks fresh CI approval even without packages or tag', async () => {
    const { manifest, expected, registry, github, dependencies } = await fixture();
    missingPackages(registry, NAMES);
    owners(registry, OLD_VERSION);
    github.release = { status: 200, body: releaseRecord(TAG, 17, SOURCE, true) };
    github.tags.set(TAG, { status: 404, body: {} });
    github.releases = [];
    await expect(auditCanaryPublication(manifest, expected, dependencies, 'ci')).rejects.toThrow(
      'original approval evidence'
    );
  });
  test('selected tag auth errors retain their real status instead of becoming absence', async () => {
    const { manifest, expected, registry, github, dependencies } = await fixture();
    missingPackages(registry, NAMES);
    owners(registry, OLD_VERSION);
    github.release = { status: 404, body: {} };
    github.releases = [];
    github.tagSequences.set(TAG, [
      { status: 404, body: {} },
      { status: 403, body: {} },
    ]);
    await expect(auditCanaryPublication(manifest, expected, dependencies, 'ci')).rejects.toThrow(
      'expected HTTP200 or HTTP404; received 403'
    );
  });
  test('a tag appearing after the release check still needs its exact full source', async () => {
    const { manifest, expected, registry, github, dependencies } = await fixture();
    missingPackages(registry, NAMES);
    owners(registry, OLD_VERSION);
    github.release = { status: 404, body: {} };
    github.releases = [];
    github.tagSequences.set(TAG, [
      { status: 404, body: {} },
      { status: 200, body: OLD },
    ]);
    await expect(auditCanaryPublication(manifest, expected, dependencies, 'ci')).rejects.toThrow(
      `expected exact full source ${SOURCE}`
    );
  });
});

describe('read-only audit CLI', () => {
  test('writes actual receipts and decisions to a separate audit JSON file without OIDC', async () => {
    const { manifest, expected, dependencies } = await fixture();
    const directory = mkdtempSync(join(tmpdir(), 'fix-canary-publication-audit-cli-'));
    try {
      const manifestPath = join(directory, 'manifest.json');
      const expectedPath = join(directory, 'expected.json');
      const outputPath = join(directory, 'out', 'audit.json');
      writeFileSync(manifestPath, JSON.stringify(manifest));
      writeFileSync(expectedPath, JSON.stringify(expected));
      const audit = await runAuditCanaryPublicationCli(
        [manifestPath],
        {
          REPO: REPOSITORY,
          SOURCE_SHA: SOURCE,
          VERSION,
          EXPECTED_RELEASE: expectedPath,
          PUBLICATION_AUDIT: outputPath,
          EXPECTED_MANIFEST_SHA256: digest(JSON.stringify(manifest)),
          EXPECTED_RELEASE_SHA256: digest(JSON.stringify(expected)),
        },
        dependencies
      );
      expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toEqual(audit);
      expect(audit?.decision).toBe('noop');
      expect(readFileSync(manifestPath, 'utf8')).toBe(JSON.stringify(manifest));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  test('shell outputs contain only fixed reason and boolean needs from actual partial receipts', async () => {
    const { manifest, expected, registry, github, dependencies } = await fixture();
    missingPackages(registry, [MAIN_PACKAGE]);
    registry.owners.set(MAIN_PACKAGE, OLD_VERSION);
    github.release = { status: 200, body: releaseRecord(TAG, 17, SOURCE, true) };
    github.releases = [github.release.body];
    github.assets = (github.assets as readonly unknown[]).slice(0, 1);
    const directory = mkdtempSync(join(tmpdir(), 'fix-canary-publication-audit-outputs-'));
    try {
      const manifestPath = join(directory, 'manifest.json');
      const expectedPath = join(directory, 'expected.json');
      const outputPath = join(directory, 'audit.json');
      const shellPath = join(directory, 'github-output');
      writeFileSync(manifestPath, JSON.stringify(manifest));
      writeFileSync(expectedPath, JSON.stringify(expected));
      await runAuditCanaryPublicationCli(
        [manifestPath, expectedPath, outputPath],
        { REPO: REPOSITORY, GITHUB_OUTPUT: shellPath, APPROVAL_ORIGIN: 'actions' },
        dependencies
      );
      expect(readFileSync(shellPath, 'utf8')).toBe(
        'npm_needed=true\npackages_needed=true\ntags_needed=true\ngithub_needed=true\nreason=partial-publication\n'
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  test('refuses changed pinned evidence, source identity and output clobbering before reads', async () => {
    const { manifest, expected, dependencies, registry } = await fixture();
    const directory = mkdtempSync(join(tmpdir(), 'fix-canary-publication-audit-cli-'));
    try {
      const manifestPath = join(directory, 'manifest.json');
      const expectedPath = join(directory, 'expected.json');
      const outputPath = join(directory, 'audit.json');
      writeFileSync(manifestPath, JSON.stringify(manifest));
      writeFileSync(expectedPath, JSON.stringify(expected));
      await expect(
        runAuditCanaryPublicationCli(
          [manifestPath, expectedPath, outputPath],
          { REPO: REPOSITORY, EXPECTED_MANIFEST_SHA256: 'f'.repeat(64) },
          dependencies
        )
      ).rejects.toThrow('expected SHA256');
      await expect(
        runAuditCanaryPublicationCli(
          [manifestPath, expectedPath, outputPath],
          { REPO: REPOSITORY, EXPECTED_RELEASE_SHA256: 'f'.repeat(64) },
          dependencies
        )
      ).rejects.toThrow('expected SHA256');
      await expect(
        runAuditCanaryPublicationCli(
          [manifestPath, expectedPath, outputPath],
          { REPO: REPOSITORY, SOURCE_SHA: OLD },
          dependencies
        )
      ).rejects.toThrow('Canary audit source mismatch');
      await expect(
        runAuditCanaryPublicationCli(
          [manifestPath, expectedPath, manifestPath],
          { REPO: REPOSITORY },
          dependencies
        )
      ).rejects.toThrow('expected path distinct');
      expect(registry.calls).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  test('CLI fresh-CI recovery refusal emits no approval or publisher outputs', async () => {
    const { manifest, expected, registry, github, dependencies } = await fixture();
    missingPackages(registry, NAMES.slice(3));
    owners(registry, OLD_VERSION);
    for (const name of NAMES.slice(0, 3)) registry.owners.set(name, VERSION);
    github.release = { status: 404, body: {} };
    github.tags.set(TAG, { status: 404, body: {} });
    github.releases = [];
    const directory = mkdtempSync(join(tmpdir(), 'fix-canary-publication-audit-ci-cli-'));
    try {
      const manifestPath = join(directory, 'manifest.json');
      const expectedPath = join(directory, 'expected.json');
      const outputPath = join(directory, 'audit.json');
      const shellPath = join(directory, 'github-output');
      writeFileSync(manifestPath, JSON.stringify(manifest));
      writeFileSync(expectedPath, JSON.stringify(expected));
      await expect(
        runAuditCanaryPublicationCli(
          [manifestPath, expectedPath, outputPath],
          { REPO: REPOSITORY, APPROVAL_ORIGIN: 'ci', GITHUB_OUTPUT: shellPath },
          dependencies
        )
      ).rejects.toThrow('original approval evidence');
      expect(existsSync(outputPath)).toBe(false);
      expect(existsSync(shellPath)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  test('invalid CLI approval origin fails before reading inputs or publication state', async () => {
    const { dependencies, registry, github } = await fixture();
    await expect(
      runAuditCanaryPublicationCli(
        [],
        { REPO: REPOSITORY, APPROVAL_ORIGIN: 'rebuild' },
        dependencies
      )
    ).rejects.toThrow('expected ci | actions | release');
    expect(registry.calls).toEqual([]);
    expect(github.calls).toEqual([]);
  });
  test('requires repository identity and bounded positional arguments', async () => {
    await expect(runAuditCanaryPublicationCli([], {})).rejects.toThrow('expected owner/repository');
    await expect(runAuditCanaryPublicationCli(['--invalid'], {})).rejects.toThrow(
      'expected optional manifest'
    );
    expect(await runAuditCanaryPublicationCli(['--help'], {})).toBe(null);
  });
  test('the ancestry process boundary rejects mutation flags, foreign repositories and non-GET paths', async () => {
    const process = new AuditProcess();
    const runner = new CanaryAuditReadRunner(REPOSITORY, {}, process);
    for (const command of [
      ['gh', 'release', 'create'],
      ['gh', 'api', `repos/${REPOSITORY}/commits/source`, '--method', 'DELETE'],
      ['gh', 'api', 'repos/other/repo/commits/source'],
      ['gh', 'api', `repos/${REPOSITORY}/releases`],
    ])
      expect(() => runner.run(command)).toThrow(
        'expected repository-scoped GitHub commit/compare GET'
      );
    expect(process.calls).toEqual([]);
    expect(await runner.run(['gh', 'api', `repos/${REPOSITORY}/commits/aaaaaaa`])).toEqual({
      exitCode: 0,
      stdout: 'fixture-json',
      stderr: '',
    });
    expect(process.calls).toHaveLength(1);
  });
});
