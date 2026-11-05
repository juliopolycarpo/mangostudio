import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

import {
  type RegistryClient,
  type RegistryResponse,
  verifyCanaryNpmPublication,
} from '../lib/canary-publication';
import {
  CANARY_TAG_NPM_VERSION,
  type CanaryTagAncestry,
  type CanaryTagDependencies,
  canaryTagEnvironment,
  type CanaryTagRunner,
  planCanaryTagUpdates,
  promoteCanaryTags,
} from '../lib/canary-tags';
import type { DistributionManifest } from '../lib/distribution-manifest';
import { MAIN_PACKAGE, NPM_PLATFORMS, platformPackageName } from '../lib/npm-pack';
import type { NpmCommandResult } from '../lib/npm-publish';

const SOURCE = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const VERSION = '1.2.3-canary.aaaaaaa';
const OLD_VERSION = '1.2.3-canary.bbbbbbb';
const NAMES = [...NPM_PLATFORMS.map(platformPackageName), MAIN_PACKAGE];
const OIDC_ENV = {
  GITHUB_ACTIONS: 'true',
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.githubusercontent.com/request',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic-oidc-request-token',
};

function versionUrl(name: string): string {
  return `https://registry.npmjs.org/${encodeURIComponent(name)}/${VERSION}`;
}

class FakeCanaryRegistry implements RegistryClient {
  readonly versions = new Map<string, RegistryResponse<unknown>>();
  readonly archives = new Map<string, RegistryResponse<Uint8Array>>();
  readonly owners = new Map<string, string | null>();
  readonly failures = new Map<string, Error>();
  readonly events: string[];
  writesStarted = false;
  readonly hiddenVersionReads = new Map<string, number>();
  readonly hiddenArchiveReads = new Map<string, number>();
  readonly servedArchives: string[] = [];
  postWriteResponse?: RegistryResponse<unknown>;
  constructor(events: string[]) {
    this.events = events;
  }

  getJson(url: string): Promise<RegistryResponse<unknown>> {
    this.events.push(`json:${url}`);
    const failure = this.failures.get(url);
    if (failure) throw failure;
    const tagPrefix = 'https://registry.npmjs.org/-/package/';
    if (url.startsWith(tagPrefix) && url.endsWith('/dist-tags')) {
      if (this.writesStarted && this.postWriteResponse)
        return Promise.resolve(this.postWriteResponse);
      const name = decodeURIComponent(url.slice(tagPrefix.length, -'/dist-tags'.length));
      if (!this.owners.has(name)) throw new Error(`Unexpected fake registry package ${name}`);
      const owner = this.owners.get(name);
      return Promise.resolve({
        status: 200,
        body: { latest: '1.2.2', ...(owner ? { canary: owner } : {}) },
      });
    }
    const hidden = this.hiddenVersionReads.get(url) ?? 0;
    if (hidden > 0) {
      this.hiddenVersionReads.set(url, hidden - 1);
      return Promise.resolve({ status: 404, body: null });
    }
    const result = this.versions.get(url);
    if (!result) throw new Error(`Unexpected fake registry version URL ${url}`);
    return Promise.resolve(result);
  }
  getBytes(url: string): Promise<RegistryResponse<Uint8Array>> {
    this.events.push(`archive:${url}`);
    const failure = this.failures.get(url);
    if (failure) throw failure;
    const hidden = this.hiddenArchiveReads.get(url) ?? 0;
    if (hidden > 0) {
      this.hiddenArchiveReads.set(url, hidden - 1);
      return Promise.resolve({ status: 404, body: new Uint8Array() });
    }
    const result = this.archives.get(url);
    if (!result) throw new Error(`Unexpected fake registry archive URL ${url}`);
    if (result.status === 200) this.servedArchives.push(url);
    return Promise.resolve(result);
  }
}

class FakeCanaryAncestry implements CanaryTagAncestry {
  readonly commits = new Map([
    ['aaaaaaa', SOURCE],
    ['bbbbbbb', OLD],
  ]);
  readonly relations = new Map<string, 'ahead' | 'identical' | 'behind' | 'diverged'>();
  readonly calls: string[] = [];
  resolveCommit(prefix: string): Promise<string> {
    this.calls.push(`resolve:${prefix}`);
    const commit = this.commits.get(prefix);
    if (!commit) throw new Error(`Unresolved fixture source prefix ${prefix}`);
    return Promise.resolve(commit);
  }
  compare(base: string, head: string): Promise<'ahead' | 'identical' | 'behind' | 'diverged'> {
    this.calls.push(`compare:${base}...${head}`);
    return Promise.resolve(this.relations.get(base) ?? 'ahead');
  }
}

class FakeCanaryCommands implements CanaryTagRunner {
  readonly commands: (readonly string[])[] = [];
  nodeVersion = 'v22.14.0\n';
  npmVersion = `${CANARY_TAG_NPM_VERSION}\n`;
  probeExitCode = 0;
  failPackage?: string;
  applyWrites = true;
  constructor(private readonly registry: FakeCanaryRegistry) {}
  run(command: readonly string[]): Promise<NpmCommandResult> {
    this.commands.push([...command]);
    if (command.join(' ') === 'node --version')
      return Promise.resolve({
        exitCode: this.probeExitCode,
        stdout: this.nodeVersion,
        stderr: '',
      });
    if (command.join(' ') === `bunx --package npm@${CANARY_TAG_NPM_VERSION} npm --version`)
      return Promise.resolve({ exitCode: this.probeExitCode, stdout: this.npmVersion, stderr: '' });
    if (command[4] !== 'dist-tag' || command[5] !== 'add' || command[7] !== 'canary')
      throw new Error(`Unexpected fake command ${command.join(' ')}`);
    const specification = command[6];
    if (!specification?.endsWith(`@${VERSION}`))
      throw new Error(`Unexpected fake package specification ${specification}`);
    const name = specification.slice(0, -VERSION.length - 1);
    if (!NAMES.includes(name)) throw new Error(`Unexpected fake package ${name}`);
    this.registry.events.push(`write:${name}`);
    this.registry.writesStarted = true;
    if (name === this.failPackage)
      return Promise.resolve({
        exitCode: 1,
        stdout: '',
        stderr: 'npm error E403 Allow npm dist-tag denied',
      });
    if (this.applyWrites) this.registry.owners.set(name, VERSION);
    return Promise.resolve({ exitCode: 0, stdout: `+canary: ${name}@${VERSION}`, stderr: '' });
  }
  get writes(): readonly (readonly string[])[] {
    return this.commands.filter((command) => command[4] === 'dist-tag');
  }
}

interface Fixture {
  readonly manifest: DistributionManifest;
  readonly registry: FakeCanaryRegistry;
  readonly runner: FakeCanaryCommands;
  readonly ancestry: FakeCanaryAncestry;
  readonly dependencies: CanaryTagDependencies;
  readonly events: string[];
}

async function fixture(): Promise<Fixture> {
  const events: string[] = [];
  const registry = new FakeCanaryRegistry(events);
  const files: DistributionManifest['files'][number][] = [];
  const descriptions = [
    ...NPM_PLATFORMS.map((platform) => ({
      name: platformPackageName(platform),
      directory: `dist-npm/${platform.os}-${platform.cpu}`,
      files: [platform.binary, platform.runtimeBinary],
    })),
    { name: MAIN_PACKAGE, directory: 'dist-npm/cli', files: ['README.md', 'bin/mangostudio.js'] },
  ];
  for (const description of descriptions) {
    const contents: Record<string, string> = {
      'package/package.json': JSON.stringify({ name: description.name, version: VERSION }),
    };
    for (const file of description.files)
      contents[`package/${file}`] = `${description.name} approved ${file}`;
    for (const [path, content] of Object.entries(contents))
      files.push({
        path: `${description.directory}/${path.slice(8)}`,
        size: Buffer.byteLength(content),
        sha256: createHash('sha256').update(content).digest('hex'),
      });
    let archive: Uint8Array = await new Bun.Archive(contents, { compress: 'gzip' }).bytes();
    if (/^@mangostudio\/cli-(linux|darwin)-/.test(description.name)) {
      archive = executableFixtureArchive(archive);
    }
    const tarball = `https://registry.npmjs.org/${description.name}/-/${description.name.split('/').at(-1)}-${VERSION}.tgz`;
    registry.archives.set(tarball, { status: 200, body: archive });
    registry.versions.set(versionUrl(description.name), {
      status: 200,
      body: {
        name: description.name,
        version: VERSION,
        _id: `${description.name}@${VERSION}`,
        dist: {
          integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}`,
          tarball,
          attestations: {
            url: `https://registry.npmjs.org/-/npm/v1/attestations/${description.name.replaceAll('/', '%2f')}@${VERSION}`,
            provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
          },
        },
      },
    });
    registry.owners.set(description.name, OLD_VERSION);
  }
  const manifest: DistributionManifest = {
    schemaVersion: 5,
    sourceSha: SOURCE,
    dirty: false,
    packageVersion: VERSION,
    channel: 'canary',
    runtimeProfile: 'shipping',
    bunVersion: '1.4.4',
    bunRevision: 'd'.repeat(40),
    targets: [],
    files,
  };
  const runner = new FakeCanaryCommands(registry);
  const ancestry = new FakeCanaryAncestry();
  return {
    manifest,
    registry,
    runner,
    ancestry,
    dependencies: { registry, runner, ancestry, env: OIDC_ENV, visibility: { retryDelaysMs: [] } },
    events,
  };
}

function executableFixtureArchive(bytes: Uint8Array): Uint8Array {
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
      const checksum = header
        .reduce((total, byte) => total + byte, 0)
        .toString(8)
        .padStart(6, '0');
      header.write(`${checksum}\0 `, 148, 8, 'ascii');
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return gzipSync(tar);
}

describe('canary OIDC tag recovery', () => {
  test('verifies all seven archives before platform-first/wrapper-last writes, then confirms every tag', async () => {
    const { manifest, runner, dependencies, events } = await fixture();
    const result = await promoteCanaryTags(manifest, dependencies);
    expect(result).toEqual({ sourceSha: SOURCE, version: VERSION, updated: NAMES, unchanged: [] });
    const firstWrite = events.findIndex((event) => event.startsWith('write:'));
    expect(
      events.slice(0, firstWrite).filter((event) => event.startsWith('archive:'))
    ).toHaveLength(7);
    expect(events.filter((event) => event.startsWith('write:'))).toEqual(
      NAMES.map((name) => `write:${name}`)
    );
    const lastWrite = events.reduce(
      (latest, event, index) => (event.startsWith('write:') ? index : latest),
      -1
    );
    expect(events.slice(lastWrite + 1)).toHaveLength(7);
    for (const [index, command] of runner.writes.entries())
      expect(command).toEqual([
        'bunx',
        '--package',
        'npm@11.21.0',
        'npm',
        'dist-tag',
        'add',
        `${NAMES[index]}@${VERSION}`,
        'canary',
        '--registry=https://registry.npmjs.org',
      ]);
    expect(runner.commands.some((command) => command.includes('latest'))).toBe(false);
  });
  test('a version whose packages exist still repairs tags after an interruption', async () => {
    const { manifest, registry, runner, dependencies } = await fixture();
    registry.owners.set(NAMES[0] ?? '', VERSION);
    registry.owners.set(NAMES[1] ?? '', VERSION);
    const result = await promoteCanaryTags(manifest, dependencies);
    expect(result.updated).toEqual(NAMES.slice(2));
    expect(result.unchanged).toEqual(NAMES.slice(0, 2));
    expect(runner.writes.at(-1)?.[6]).toBe(`mangostudio@${VERSION}`);
  });
  test('verified complete versions produce no tag writes', async () => {
    const { manifest, registry, runner, dependencies } = await fixture();
    for (const name of NAMES) registry.owners.set(name, VERSION);
    expect(await promoteCanaryTags(manifest, dependencies)).toEqual({
      sourceSha: SOURCE,
      version: VERSION,
      updated: [],
      unchanged: NAMES,
    });
    expect(runner.writes).toEqual([]);
  });
  test('absent channel owners can be installed only after packages are byte-verified', async () => {
    const { manifest, registry, ancestry, dependencies } = await fixture();
    for (const name of NAMES) registry.owners.set(name, null);
    expect((await promoteCanaryTags(manifest, dependencies)).updated).toEqual(NAMES);
    expect(ancestry.calls).toEqual([]);
  });
  test.each(['behind', 'diverged', 'identical'] as const)(
    'rejects selected source %s an existing owner before every write',
    async (relation) => {
      const { manifest, registry, runner, ancestry, dependencies } = await fixture();
      registry.owners.set(MAIN_PACKAGE, '1.2.3-canary.ccccccc');
      ancestry.commits.set('ccccccc', 'c'.repeat(40));
      ancestry.relations.set('c'.repeat(40), relation);
      await expect(promoteCanaryTags(manifest, dependencies)).rejects.toThrow(
        `expected selected source ahead of owner ${'c'.repeat(40)}; received ${relation}`
      );
      expect(runner.writes).toEqual([]);
    }
  );
  test('resolves the git-prefixed numeric canary source identifier', async () => {
    const { manifest, registry, ancestry, dependencies } = await fixture();
    for (const name of NAMES) registry.owners.set(name, '1.2.3-canary.g0123456');
    ancestry.commits.set('0123456', `0123456${'b'.repeat(33)}`);
    await promoteCanaryTags(manifest, dependencies);
    expect(ancestry.calls).toContain('resolve:0123456');
  });
  test.each(['1.2.3', '1.2.3-beta.1', '1.2.3-canary.gabcdef0'])(
    'rejects unprovable canary owner %s before writes',
    async (owner) => {
      const { manifest, registry, runner, dependencies } = await fixture();
      registry.owners.set(MAIN_PACKAGE, owner);
      await expect(promoteCanaryTags(manifest, dependencies)).rejects.toThrow(
        'expected SHA-stamped canary version'
      );
      expect(runner.writes).toEqual([]);
    }
  );
  test('rejects a commit resolution that does not match its owner prefix', async () => {
    const { manifest, runner, ancestry, dependencies } = await fixture();
    ancestry.commits.set('bbbbbbb', 'd'.repeat(40));
    await expect(promoteCanaryTags(manifest, dependencies)).rejects.toThrow(
      'expected full SHA with prefix bbbbbbb'
    );
    expect(runner.writes).toEqual([]);
  });
  test('rejects an unresolved owner rather than guessing an ancestry baseline', async () => {
    const { manifest, runner, ancestry, dependencies } = await fixture();
    ancestry.commits.delete('bbbbbbb');
    await expect(promoteCanaryTags(manifest, dependencies)).rejects.toThrow(
      'Unresolved fixture source prefix bbbbbbb'
    );
    expect(runner.writes).toEqual([]);
  });
  test('a shared short version cannot stand in for the full selected source', async () => {
    const { manifest, registry, ancestry, runner, dependencies } = await fixture();
    for (const name of NAMES) registry.owners.set(name, VERSION);
    ancestry.commits.set('aaaaaaa', `aaaaaaa${'c'.repeat(33)}`);
    await expect(promoteCanaryTags(manifest, dependencies)).rejects.toThrow(
      'Ambiguous canary version'
    );
    expect(runner.writes).toEqual([]);
  });
  test('rejects a different version alias for the identical full source before writes', async () => {
    const { manifest, registry, runner, dependencies } = await fixture();
    for (const name of NAMES) registry.owners.set(name, '1.2.2-canary.aaaaaaa');
    await expect(promoteCanaryTags(manifest, dependencies)).rejects.toThrow(
      'expected identical source owner version 1.2.3-canary.aaaaaaa'
    );
    expect(runner.writes).toEqual([]);
  });
  test('a missing wrapper package blocks every tag write', async () => {
    const { manifest, registry, runner, dependencies } = await fixture();
    registry.versions.set(versionUrl(MAIN_PACKAGE), { status: 404, body: {} });
    await expect(promoteCanaryTags(manifest, dependencies)).rejects.toThrow(
      'requires all seven verified packages; missing mangostudio'
    );
    expect(runner.writes).toEqual([]);
  });
  test('changed published bytes block promotion despite equal source/version', async () => {
    const { manifest, registry, runner, dependencies } = await fixture();
    const first = [...registry.archives.entries()][0];
    if (!first) throw new Error('Fixture lacks first archive');
    registry.archives.set(first[0], { status: 200, body: new Uint8Array([1, 2, 3]) });
    await expect(promoteCanaryTags(manifest, dependencies)).rejects.toThrow(
      'Registry archive integrity mismatch'
    );
    expect(runner.writes).toEqual([]);
  });
  test('registry permission failures block promotion', async () => {
    const { manifest, registry, runner, dependencies } = await fixture();
    registry.versions.set(versionUrl(NAMES[0] ?? ''), { status: 403, body: {} });
    await expect(promoteCanaryTags(manifest, dependencies)).rejects.toThrow(
      'expected HTTP 200, received 403'
    );
    expect(runner.writes).toEqual([]);
  });
  test('a denied platform operation stops before the wrapper and preserves previous side effects', async () => {
    const { manifest, registry, runner, dependencies } = await fixture();
    runner.failPackage = NAMES[1];
    await expect(promoteCanaryTags(manifest, dependencies)).rejects.toThrow(
      'Allow npm dist-tag permission'
    );
    expect(runner.writes.map((command) => command[6])).toEqual(
      NAMES.slice(0, 2).map((name) => `${name}@${VERSION}`)
    );
    expect(registry.owners.get(NAMES[0] ?? '')).toBe(VERSION);
    expect(registry.owners.get(MAIN_PACKAGE)).toBe(OLD_VERSION);
  });
  test('a successful command without a confirmed changed tag fails', async () => {
    const { manifest, runner, dependencies } = await fixture();
    runner.applyWrites = false;
    await expect(promoteCanaryTags(manifest, dependencies)).rejects.toThrow(
      'Canary tag verification'
    );
  });
  test.each([403, 500])('post-write HTTP%i does not become confirmed promotion', async (status) => {
    const { manifest, registry, dependencies } = await fixture();
    registry.postWriteResponse = { status, body: {} };
    await expect(promoteCanaryTags(manifest, dependencies)).rejects.toThrow(
      `received status=${status}`
    );
  });
  test.each(['v20.17.0', 'v22.13.1', 'v22.14.0-rc.1', 'invalid'])(
    'rejects unsupported trusted-publishing Node runtime %s',
    async (nodeVersion) => {
      const { manifest, runner, dependencies } = await fixture();
      runner.nodeVersion = nodeVersion;
      await expect(promoteCanaryTags(manifest, dependencies)).rejects.toThrow(
        'expected stable Node >=22.14.0'
      );
      expect(runner.writes).toEqual([]);
    }
  );
  test('refuses an unexpected npm revision even when newer', async () => {
    const { manifest, runner, dependencies } = await fixture();
    runner.npmVersion = '11.22.0';
    await expect(promoteCanaryTags(manifest, dependencies)).rejects.toThrow('expected 11.21.0');
    expect(runner.writes).toEqual([]);
  });
  test('a failed runtime probe fails before registry reads', async () => {
    const { manifest, runner, registry, dependencies } = await fixture();
    runner.probeExitCode = 1;
    await expect(promoteCanaryTags(manifest, dependencies)).rejects.toThrow(
      'Node runtime probe: expected exit0; received 1'
    );
    expect(registry.events).toEqual([]);
  });
});

function ownerMap(version: string | null = OLD_VERSION): Readonly<Record<string, string | null>> {
  return Object.fromEntries(NAMES.map((name) => [name, version]));
}

describe('read-only canary owner planning before publication', () => {
  test('accepts a verified ancestor owner map while every selected package is still missing', async () => {
    const { manifest, registry, runner, ancestry } = await fixture();
    for (const name of NAMES) registry.versions.set(versionUrl(name), { status: 404, body: {} });
    const publication = await verifyCanaryNpmPublication(manifest, registry);
    expect(publication.missing).toEqual(NAMES);
    expect(await planCanaryTagUpdates(manifest, publication.canary, ancestry)).toEqual({
      updates: NAMES,
      unchanged: [],
    });
    expect(runner.commands).toEqual([]);
  });
  test('fresh owner reads reject an older failed-job retry after a newer source takes the wrapper tag', async () => {
    const { manifest, registry, ancestry, runner } = await fixture();
    for (const name of NAMES) registry.versions.set(versionUrl(name), { status: 404, body: {} });
    const prepared = await verifyCanaryNpmPublication(manifest, registry);
    expect((await planCanaryTagUpdates(manifest, prepared.canary, ancestry)).updates).toEqual(
      NAMES
    );
    registry.owners.set(MAIN_PACKAGE, '1.2.3-canary.ccccccc');
    ancestry.commits.set('ccccccc', 'c'.repeat(40));
    ancestry.relations.set('c'.repeat(40), 'behind');
    const fresh = await verifyCanaryNpmPublication(manifest, registry);
    await expect(planCanaryTagUpdates(manifest, fresh.canary, ancestry)).rejects.toThrow(
      'expected selected source ahead of owner'
    );
    expect(runner.commands).toEqual([]);
  });
  test('requires exactly the seven own owner keys before ancestry reads', async () => {
    const { manifest, ancestry } = await fixture();
    const missing = { ...ownerMap() };
    delete missing.mangostudio;
    for (const owners of [
      missing,
      { ...ownerMap(), unexpected: null },
      Object.assign(Object.create({ mangostudio: OLD_VERSION }), missing),
    ]) {
      await expect(planCanaryTagUpdates(manifest, owners, ancestry)).rejects.toThrow(
        'expected exactly'
      );
    }
    expect(ancestry.calls).toEqual([]);
  });
  test.each([undefined, 42, true, {}].map((owner) => [owner]))(
    'refuses unproven owner value %j before ancestry reads',
    async (owner) => {
      const { manifest, ancestry } = await fixture();
      const owners = { ...ownerMap(), mangostudio: owner } as unknown as Readonly<
        Record<string, string | null>
      >;
      await expect(planCanaryTagUpdates(manifest, owners, ancestry)).rejects.toThrow(
        'expected version or explicit absent tag'
      );
      expect(ancestry.calls).toEqual([]);
    }
  );
  test('absent owners remain explicit and require no OIDC or ancestry requests', async () => {
    const { manifest, ancestry, runner } = await fixture();
    expect(await planCanaryTagUpdates(manifest, ownerMap(null), ancestry)).toEqual({
      updates: NAMES,
      unchanged: [],
    });
    expect(ancestry.calls).toEqual([]);
    expect(runner.commands).toEqual([]);
  });
  test('identical selected source/version is unchanged after full-prefix resolution', async () => {
    const { manifest, ancestry } = await fixture();
    expect(await planCanaryTagUpdates(manifest, ownerMap(VERSION), ancestry)).toEqual({
      updates: [],
      unchanged: NAMES,
    });
    expect(ancestry.calls).toEqual(['resolve:aaaaaaa']);
  });
  test('accepts the SHA-stamped version produced from a prerelease root version', async () => {
    const { manifest, ancestry } = await fixture();
    const version = '1.2.3-rc.0-canary.aaaaaaa';
    expect(
      await planCanaryTagUpdates(
        { ...manifest, packageVersion: version },
        ownerMap(version),
        ancestry
      )
    ).toEqual({
      updates: [],
      unchanged: NAMES,
    });
    expect(ancestry.calls).toEqual(['resolve:aaaaaaa']);
  });
  test('a full source mismatch cannot be hidden behind a shared short owner prefix', async () => {
    const { manifest, ancestry } = await fixture();
    ancestry.commits.set('bbbbbbb', 'd'.repeat(40));
    await expect(planCanaryTagUpdates(manifest, ownerMap(), ancestry)).rejects.toThrow(
      'expected full SHA with prefix bbbbbbb'
    );
  });
  test('equal source with a different package-version alias fails closed', async () => {
    const { manifest, ancestry } = await fixture();
    await expect(
      planCanaryTagUpdates(manifest, ownerMap('1.2.2-canary.aaaaaaa'), ancestry)
    ).rejects.toThrow('expected identical source owner version');
  });
  test('noncanonical numeric owner identifiers cannot be treated as source proofs', async () => {
    const { manifest, ancestry } = await fixture();
    await expect(
      planCanaryTagUpdates(manifest, ownerMap('1.2.3-canary.0000000'), ancestry)
    ).rejects.toThrow('expected SHA-stamped canary version');
    expect(ancestry.calls).toEqual([]);
  });
  test.each([
    { sourceSha: 'aaaaaaa' },
    { sourceSha: SOURCE.toUpperCase() },
    { packageVersion: 'v1.2.3-canary.aaaaaaa' },
    { packageVersion: '1.2.3-canary.bbbbbbb' },
    { runtimeProfile: 'light' },
    { dirty: true },
    { channel: 'pr' },
  ])('rejects malformed selected manifest %j before ancestry reads', async (mutation) => {
    const { manifest, ancestry } = await fixture();
    await expect(
      planCanaryTagUpdates(
        { ...manifest, ...mutation } as DistributionManifest,
        ownerMap(),
        ancestry
      )
    ).rejects.toThrow('expected clean shipping canary');
    expect(ancestry.calls).toEqual([]);
  });
});

describe('OIDC-only canary environment', () => {
  test('retains OIDC and strips alternate npm configuration', () => {
    const env = canaryTagEnvironment({
      ...OIDC_ENV,
      PATH: '/test/path',
      NPM_CONFIG_REGISTRY: 'https://other.example',
      npm_config_userconfig: '/secret/npmrc',
      NODE_AUTH_TOKEN: '',
    });
    expect(env).toEqual({ ...OIDC_ENV, PATH: '/test/path' });
  });
  test.each([
    'NODE_AUTH_TOKEN',
    'NPM_TOKEN',
    'npm_auth_token',
    'npm_config_//registry.npmjs.org/:_authToken',
  ])('rejects legacy credential %s without revealing it', (name) => {
    try {
      canaryTagEnvironment({ ...OIDC_ENV, [name]: 'secret-fixture-value' });
      throw new Error('Fixture expected refusal');
    } catch (cause) {
      const message = String(cause);
      expect(message).toContain(`refuses legacy npm credential ${name}`);
      expect(message).not.toContain('secret-fixture-value');
    }
  });
  test.each(['GITHUB_ACTIONS', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL'])(
    'requires OIDC prerequisite %s',
    (name) => {
      expect(() => canaryTagEnvironment({ ...OIDC_ENV, [name]: undefined })).toThrow(
        'requires GitHub Actions OIDC'
      );
    }
  );
  test.each([
    'not-a-url',
    'http://token.example/request',
    'https://user:secret@token.example/request',
    'https://token.example/request#fragment',
  ])('rejects invalid OIDC URL %s', (url) => {
    expect(() => canaryTagEnvironment({ ...OIDC_ENV, ACTIONS_ID_TOKEN_REQUEST_URL: url })).toThrow(
      'expected absolute HTTPS OIDC endpoint'
    );
  });
});

class FakeTagVisibilitySleeper {
  readonly delays: number[] = [];
  sleep(delay: number): Promise<void> {
    this.delays.push(delay);
    return Promise.resolve();
  }
}

test('waits for just-published versions before one byte audit and any tag write', async () => {
  const { manifest, registry, runner, dependencies, events } = await fixture();
  const clock = new FakeTagVisibilitySleeper();
  registry.hiddenVersionReads.set(versionUrl(NAMES[0] ?? MAIN_PACKAGE), 2);
  const result = await promoteCanaryTags(manifest, {
    ...dependencies,
    visibility: { retryDelaysMs: [1, 2], sleep: clock.sleep.bind(clock) },
  });
  expect(result.updated).toEqual(NAMES);
  expect(clock.delays).toEqual([1, 2]);
  expect(events.filter((event) => event.startsWith('archive:'))).toHaveLength(7);
  expect(runner.writes).toHaveLength(7);
});

test('visibility exhaustion still refuses tag writes and audits each visible archive only once', async () => {
  const { manifest, registry, runner, dependencies, events } = await fixture();
  const clock = new FakeTagVisibilitySleeper();
  registry.versions.set(versionUrl(NAMES[0] ?? MAIN_PACKAGE), { status: 404, body: null });
  await expect(
    promoteCanaryTags(manifest, {
      ...dependencies,
      visibility: { retryDelaysMs: [1, 2], sleep: clock.sleep.bind(clock) },
    })
  ).rejects.toThrow(`missing ${NAMES[0]}`);
  expect(clock.delays).toEqual([1, 2]);
  expect(runner.writes).toEqual([]);
  expect(events.filter((event) => event.startsWith('archive:'))).toHaveLength(6);
});

test('initial package absence audit remains immediate without a post-publication window', async () => {
  const { manifest, registry } = await fixture();
  registry.hiddenVersionReads.set(versionUrl(NAMES[0] ?? MAIN_PACKAGE), 2);
  expect((await verifyCanaryNpmPublication(manifest, registry)).missing).toEqual([
    NAMES[0] ?? MAIN_PACKAGE,
  ]);
  expect(registry.hiddenVersionReads.get(versionUrl(NAMES[0] ?? MAIN_PACKAGE))).toBe(1);
});

test.each([401, 403, 429, 500])(
  'HTTP%i never spends the visibility wait budget or writes tags',
  async (status) => {
    const { manifest, registry, runner, dependencies } = await fixture();
    const clock = new FakeTagVisibilitySleeper();
    registry.versions.set(versionUrl(NAMES[0] ?? MAIN_PACKAGE), { status, body: null });
    await expect(
      promoteCanaryTags(manifest, {
        ...dependencies,
        visibility: { retryDelaysMs: [1], sleep: clock.sleep.bind(clock) },
      })
    ).rejects.toThrow(`received ${status}`);
    expect(clock.delays).toEqual([]);
    expect(runner.writes).toEqual([]);
  }
);

test('waits for one just-published tarball without downloading earlier verified archives again', async () => {
  const { manifest, registry, runner, dependencies } = await fixture();
  const clock = new FakeTagVisibilitySleeper();
  const archives = [...registry.archives.keys()];
  const delayed = archives[1];
  if (!delayed) throw new Error('fixture: expected at least two package archives');
  registry.hiddenArchiveReads.set(delayed, 2);
  await promoteCanaryTags(manifest, {
    ...dependencies,
    visibility: { retryDelaysMs: [1, 2], sleep: clock.sleep.bind(clock) },
  });
  expect(clock.delays).toEqual([1, 2]);
  expect(registry.servedArchives).toEqual(archives);
  expect(runner.writes).toHaveLength(7);
});
