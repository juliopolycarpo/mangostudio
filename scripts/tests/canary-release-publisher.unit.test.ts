import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import type { GhCommandResult } from '../lib/canary-github';
import type { CanaryReleaseExpectation, CanaryReleaseResponse } from '../lib/canary-release';
import {
  type CanaryReleaseAssetStore,
  type CanaryReleasePublisherClient,
  publishVerifiedCanaryRelease,
} from '../lib/canary-release-publisher';

const REPOSITORY = 'owner/repo';
const SOURCE = 'a'.repeat(40);
const VERSION = '1.0.0-canary.aaaaaaa';
const TAG = `v${VERSION}`;
function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
class FakeAssetStore implements CanaryReleaseAssetStore {
  readonly bytes = new Map<string, Uint8Array>([
    ['first.tar.gz', Buffer.from('first approved bytes')],
    ['second.tar.gz', Buffer.from('second approved bytes')],
  ]);
  readonly reads: string[] = [];
  readonly paths = new Map<string, string>();
  read(name: string): Promise<Uint8Array> {
    this.reads.push(name);
    const bytes = this.bytes.get(name);
    if (!bytes) throw new Error(`Missing fake asset ${name}`);
    return Promise.resolve(bytes);
  }
  path(name: string): string {
    return this.paths.get(name) ?? `/approved/${name}`;
  }
}
class FakeGitHub implements CanaryReleasePublisherClient {
  readonly writes: string[][] = [];
  readonly reads: string[] = [];
  readonly assets = new Map<string, Record<string, unknown>>();
  exists = false;
  draft = true;
  immutable = true;
  tagStatus = 404;
  tagSource = SOURCE;
  releaseStatus: number | undefined;
  readFailure: Error | undefined;
  failAtWrite: number | undefined;
  failedExitCode: number | undefined;
  applyFailedWrite = false;
  leaveDraftAfterPublish = false;
  disappearAfterCreate = false;
  hideUploaded = false;
  hiddenReadsAfterCreate = 0;
  hiddenReadsAfterUpload = 0;
  hiddenReadsAfterPublish = 0;
  createdReleaseStatus?: number;
  createdSource = SOURCE;
  private pendingHiddenReads = 0;
  private pendingAssetReads = 0;
  private pendingPublicationReads = 0;
  private lastUploadedName?: string;
  nextAssetId = 10;
  constructor(readonly store: FakeAssetStore) {}
  getRelease(tag: string): Promise<CanaryReleaseResponse> {
    this.reads.push(`release:${tag}`);
    if (this.readFailure) throw this.readFailure;
    const hidden = this.pendingHiddenReads > 0;
    if (hidden) this.pendingHiddenReads--;
    const status =
      this.releaseStatus ?? (this.exists && !hidden ? (this.createdReleaseStatus ?? 200) : 404);
    const observedDraft = this.pendingPublicationReads > 0 || this.draft;
    if (this.pendingPublicationReads > 0) this.pendingPublicationReads--;
    return Promise.resolve({
      status,
      body:
        status === 200
          ? {
              ...releaseRecord(observedDraft, this.immutable),
              target_commitish: this.createdSource,
            }
          : { message: 'Not Found' },
    });
  }
  resolveTag(tag: string): Promise<CanaryReleaseResponse> {
    this.reads.push(`tag:${tag}`);
    return Promise.resolve({
      status: this.tagStatus,
      body: this.tagStatus === 200 ? this.tagSource : { message: 'Not Found' },
    });
  }
  listAssets(id: number): Promise<readonly unknown[]> {
    this.reads.push(`assets:${id}`);
    const hideLatest = this.pendingAssetReads > 0;
    if (hideLatest) this.pendingAssetReads--;
    return Promise.resolve(
      this.hideUploaded
        ? []
        : [...this.assets.values()].filter(
            (asset) => !hideLatest || asset.name !== this.lastUploadedName
          )
    );
  }
  seed(name: string): void {
    const bytes = this.store.bytes.get(name);
    if (!bytes) throw new Error(`Expected fake bytes ${name}`);
    this.assets.set(name, {
      id: this.nextAssetId++,
      name,
      size: bytes.byteLength,
      digest: `sha256:${sha256(bytes)}`,
      state: 'uploaded',
    });
  }
  writeCommand(args: readonly string[]): GhCommandResult {
    this.writes.push([...args]);
    const failing = this.failAtWrite === this.writes.length;
    if (!failing || this.applyFailedWrite) {
      if (
        args[0] !== 'release' ||
        args[2] !== TAG ||
        !args.includes('--repo') ||
        args.at(-1) !== REPOSITORY
      )
        throw new Error('Unexpected fake mutation shape');
      if (args[1] === 'create') {
        this.exists = !this.disappearAfterCreate;
        this.draft = true;
        this.pendingHiddenReads = this.hiddenReadsAfterCreate;
      } else if (args[1] === 'upload') {
        const path = args[3];
        if (!path) throw new Error('Expected fake upload path');
        const name = basename(path);
        if (this.assets.has(name)) throw new Error(`Fake upload would overwrite ${name}`);
        this.seed(name);
        this.lastUploadedName = name;
        this.pendingAssetReads = this.hiddenReadsAfterUpload;
      } else if (args[1] === 'edit') {
        if (!this.leaveDraftAfterPublish) {
          this.draft = false;
          this.tagStatus = 200;
          this.pendingPublicationReads = this.hiddenReadsAfterPublish;
        }
      } else throw new Error('Unexpected fake release operation');
    }
    if (failing) {
      if (this.failedExitCode !== undefined)
        return {
          exitCode: this.failedExitCode,
          stdout: new Uint8Array(),
          stderr: 'secret transport diagnostics',
        };
      throw new Error('fake interrupted command');
    }
    return { exitCode: 0, stdout: new Uint8Array(), stderr: '' };
  }
}
function releaseRecord(draft: boolean, immutable = true) {
  return {
    id: 1,
    tag_name: TAG,
    prerelease: true,
    draft,
    immutable,
    target_commitish: SOURCE,
    html_url: `https://github.com/${REPOSITORY}/releases/tag/${draft ? 'untagged-abcdef' : TAG}`,
    url: `https://api.github.com/repos/${REPOSITORY}/releases/1`,
  };
}
function fixture() {
  const store = new FakeAssetStore();
  const github = new FakeGitHub(store);
  const expected: CanaryReleaseExpectation = {
    repository: REPOSITORY,
    sourceSha: SOURCE,
    version: VERSION,
    assets: [...store.bytes].map(([name, bytes]) => ({
      name,
      size: bytes.byteLength,
      sha256: sha256(bytes),
    })),
  };
  return { store, github, expected };
}

test('creates a source-pinned draft, uploads exact missing files and publishes immutable prerelease', async () => {
  const { store, github, expected } = fixture();
  const result = await publishVerifiedCanaryRelease(expected, store, github);
  expect(result).toEqual({
    outcome: 'published',
    releaseId: 1,
    uploaded: ['first.tar.gz', 'second.tar.gz'],
    createdDraft: true,
  });
  expect(github.writes).toEqual([
    [
      'release',
      'create',
      TAG,
      '--draft',
      '--target',
      SOURCE,
      '--prerelease',
      '--latest=false',
      '--title',
      TAG,
      '--notes',
      `Canary build from ${SOURCE}.`,
      '--repo',
      REPOSITORY,
    ],
    ['release', 'upload', TAG, '/approved/first.tar.gz', '--repo', REPOSITORY],
    ['release', 'upload', TAG, '/approved/second.tar.gz', '--repo', REPOSITORY],
    [
      'release',
      'edit',
      TAG,
      '--draft=false',
      '--prerelease',
      '--latest=false',
      '--repo',
      REPOSITORY,
    ],
  ]);
  expect(github.reads.filter((value) => value.startsWith('release:')).length).toBe(6);
  expect(github.writes.flat()).not.toContain('--clobber');
  expect(github.writes.flat()).not.toContain('delete');
});
test('retains matching draft subset and fills only verified gaps', async () => {
  const { store, github, expected } = fixture();
  github.exists = true;
  github.seed('first.tar.gz');
  const originalId = github.assets.get('first.tar.gz')?.id;
  expect((await publishVerifiedCanaryRelease(expected, store, github)).uploaded).toEqual([
    'second.tar.gz',
  ]);
  expect(github.writes).toEqual([
    ['release', 'upload', TAG, '/approved/second.tar.gz', '--repo', REPOSITORY],
    [
      'release',
      'edit',
      TAG,
      '--draft=false',
      '--prerelease',
      '--latest=false',
      '--repo',
      REPOSITORY,
    ],
  ]);
  expect(github.assets.get('first.tar.gz')?.id).toBe(originalId);
  expect(store.reads).not.toContain('first.tar.gz');
});
test('complete immutable publication is noop without local reads or writes', async () => {
  const { store, github, expected } = fixture();
  github.exists = true;
  github.draft = false;
  github.tagStatus = 200;
  for (const asset of expected.assets) github.seed(asset.name);
  store.bytes.clear();
  expect(await publishVerifiedCanaryRelease(expected, store, github)).toEqual({
    outcome: 'noop',
    releaseId: 1,
    uploaded: [],
    createdDraft: false,
  });
  expect(store.reads).toEqual([]);
  expect(github.writes).toEqual([]);
});
test('fully uploaded draft can be published without local files', async () => {
  const { store, github, expected } = fixture();
  github.exists = true;
  for (const asset of expected.assets) github.seed(asset.name);
  store.bytes.clear();
  expect((await publishVerifiedCanaryRelease(expected, store, github)).outcome).toBe('published');
  expect(store.reads).toEqual([]);
  expect(github.writes.map((args) => args[1])).toEqual(['edit']);
});
test.each(['first.tar.gz', 'second.tar.gz'])(
  'bad local file %s blocks draft creation before any external mutation',
  async (name) => {
    const { store, github, expected } = fixture();
    store.bytes.set(name, Buffer.from('wrong bytes'));
    await expect(publishVerifiedCanaryRelease(expected, store, github)).rejects.toThrow(
      `Local canary asset mismatch ${name}`
    );
    expect(github.writes).toEqual([]);
    expect(github.exists).toBe(false);
  }
);
test('wrong local digest with unchanged size is rejected before draft upload', async () => {
  const { store, github, expected } = fixture();
  github.exists = true;
  store.bytes.set('first.tar.gz', Buffer.from('first changed! bytes'));
  await expect(publishVerifiedCanaryRelease(expected, store, github)).rejects.toThrow('sha256=');
  expect(github.writes).toEqual([]);
});
test.each([
  '--clobber',
  '/approved/other.tar.gz',
  '/approved/first.tar.gz#label',
  '/approved/first.tar.gz\nextra',
  '',
])('rejects altered gh upload path %j before mutation', async (path) => {
  const { store, github, expected } = fixture();
  store.paths.set('first.tar.gz', path);
  await expect(publishVerifiedCanaryRelease(expected, store, github)).rejects.toThrow(
    'expected a plain path with matching basename'
  );
  expect(github.writes).toEqual([]);
});
test('does not create a release when the existing tag points elsewhere', async () => {
  const { store, github, expected } = fixture();
  github.tagStatus = 200;
  github.tagSource = 'b'.repeat(40);
  await expect(publishVerifiedCanaryRelease(expected, store, github)).rejects.toThrow(
    'expected full source commit'
  );
  expect(store.reads).toEqual([]);
  expect(github.writes).toEqual([]);
});
test('conflicting uploaded bytes never cause clobber or draft deletion', async () => {
  const { store, github, expected } = fixture();
  github.exists = true;
  github.seed('first.tar.gz');
  Object.assign(github.assets.get('first.tar.gz') ?? {}, { digest: `sha256:${'b'.repeat(64)}` });
  await expect(publishVerifiedCanaryRelease(expected, store, github)).rejects.toThrow(
    'Published asset mismatch'
  );
  expect(github.writes).toEqual([]);
});
test.each([401, 403, 500])('HTTP%i read failure blocks every mutation', async (status) => {
  const { store, github, expected } = fixture();
  github.releaseStatus = status;
  await expect(publishVerifiedCanaryRelease(expected, store, github)).rejects.toThrow(
    `received ${status}`
  );
  expect(github.writes).toEqual([]);
});
test('transport failure blocks every mutation', async () => {
  const { store, github, expected } = fixture();
  github.readFailure = new Error('Named fake network failure');
  await expect(publishVerifiedCanaryRelease(expected, store, github)).rejects.toThrow(
    'Named fake network failure'
  );
  expect(github.writes).toEqual([]);
});
test('interruption after first upload resumes with original bytes and fills only remaining names', async () => {
  const { store, github, expected } = fixture();
  github.failAtWrite = 2;
  github.applyFailedWrite = true;
  await expect(publishVerifiedCanaryRelease(expected, store, github)).rejects.toThrow(
    'external effects may exist'
  );
  expect([...github.assets.keys()]).toEqual(['first.tar.gz']);
  expect(github.draft).toBe(true);
  const originalWrites = github.writes.length;
  github.failAtWrite = undefined;
  expect((await publishVerifiedCanaryRelease(expected, store, github)).uploaded).toEqual([
    'second.tar.gz',
  ]);
  expect(github.writes.slice(originalWrites).filter((args) => args[1] === 'upload')).toEqual([
    ['release', 'upload', TAG, '/approved/second.tar.gz', '--repo', REPOSITORY],
  ]);
});
test.each([1, 2, 4])('nonzero command at write%i stops all later phases', async (position) => {
  const { store, github, expected } = fixture();
  github.failAtWrite = position;
  github.failedExitCode = 1;
  await expect(publishVerifiedCanaryRelease(expected, store, github)).rejects.toThrow(
    'external effects may exist'
  );
  expect(github.writes).toHaveLength(position);
});
test('missing draft after successful creation is failure before upload', async () => {
  const { store, github, expected } = fixture();
  github.disappearAfterCreate = true;
  await expect(
    publishVerifiedCanaryRelease(expected, store, github, { retryDelaysMs: [] })
  ).rejects.toThrow('expected audited draft; received absent');
  expect(github.writes.map((args) => args[1])).toEqual(['create']);
});
test('invisible successful upload fails without duplicate upload attempts', async () => {
  const { store, github, expected } = fixture();
  github.hideUploaded = true;
  await expect(
    publishVerifiedCanaryRelease(expected, store, github, { retryDelaysMs: [] })
  ).rejects.toThrow('expected uploaded asset in fresh audit');
  expect(github.writes.map((args) => args[1])).toEqual(['create', 'upload']);
});
test('a final draft never becomes a claimed complete publication', async () => {
  const { store, github, expected } = fixture();
  github.leaveDraftAfterPublish = true;
  await expect(
    publishVerifiedCanaryRelease(expected, store, github, { retryDelaysMs: [] })
  ).rejects.toThrow('expected immutable complete release; received draft');
  expect(github.draft).toBe(true);
});
test('a public release without immutability fails final audit', async () => {
  const { store, github, expected } = fixture();
  github.immutable = false;
  await expect(publishVerifiedCanaryRelease(expected, store, github)).rejects.toThrow(
    'expected immutable=true'
  );
  expect(github.draft).toBe(false);
});
test('invalid expected plan is refused before local reads or writes', async () => {
  const { store, github, expected } = fixture();
  await expect(
    publishVerifiedCanaryRelease({ ...expected, sourceSha: 'main' }, store, github)
  ).rejects.toThrow('Invalid expected canary release');
  expect(store.reads).toEqual([]);
  expect(github.writes).toEqual([]);
});

const fakeGhExecutable = `#!/usr/bin/env bun
import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2);
appendFileSync(process.env.FAKE_GH_TRACE,JSON.stringify(args)+'\\n');
const responses=await Bun.file(process.env.FAKE_GH_RESPONSES).json();
const response=responses[JSON.stringify(args)];
if(!response){console.error('Unexpected fake gh request');process.exit(99);}
process.stdout.write(response.stdout);process.exit(response.exitCode);
`;
function httpJson(body: unknown): string {
  return `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`;
}
test.each([true, false])('CLI pins same-run plan digest before gh reads; valid=%s', (valid) => {
  const directory = mkdtempSync(join(tmpdir(), 'canary-publisher-cli-'));
  try {
    const { expected } = fixture();
    const raw = JSON.stringify(expected);
    const planPath = join(directory, 'expected.json');
    writeFileSync(planPath, raw);
    const ghPath = join(directory, 'gh');
    writeFileSync(ghPath, fakeGhExecutable);
    chmodSync(ghPath, 0o755);
    const responses: Record<string, { exitCode: number; stdout: string }> = {};
    responses[JSON.stringify(['api', '--include', `repos/${REPOSITORY}/releases/tags/${TAG}`])] = {
      exitCode: 0,
      stdout: httpJson(releaseRecord(false)),
    };
    responses[JSON.stringify(['api', '--include', `repos/${REPOSITORY}/git/ref/tags/${TAG}`])] = {
      exitCode: 0,
      stdout: httpJson({ object: { type: 'commit', sha: SOURCE } }),
    };
    responses[
      JSON.stringify([
        'api',
        '--paginate',
        '--slurp',
        `repos/${REPOSITORY}/releases/1/assets?per_page=100`,
      ])
    ] = {
      exitCode: 0,
      stdout: JSON.stringify([
        expected.assets.map((asset, index) => ({
          id: index + 1,
          name: asset.name,
          size: asset.size,
          digest: `sha256:${asset.sha256}`,
          state: 'uploaded',
        })),
      ]),
    };
    const responsesPath = join(directory, 'responses.json');
    writeFileSync(responsesPath, JSON.stringify(responses));
    const trace = join(directory, 'trace');
    const proc = Bun.spawnSync(['bun', './scripts/release/publish-canary.ts'], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        EXPECTED_RELEASE: planPath,
        EXPECTED_RELEASE_SHA256: valid ? sha256(Buffer.from(raw)) : 'f'.repeat(64),
        ASSET_DIR: join(directory, 'intentionally-absent-assets'),
        REPO: REPOSITORY,
        FAKE_GH_RESPONSES: responsesPath,
        FAKE_GH_TRACE: trace,
      },
    });
    expect(proc.exitCode).toBe(valid ? 0 : 1);
    if (valid) {
      expect(JSON.parse(proc.stdout.toString()).outcome).toBe('noop');
      expect(readFileSync(trace, 'utf8').trim().split('\n')).toHaveLength(3);
    } else {
      expect(proc.stderr.toString()).toContain('Expected release plan SHA256');
      expect(existsSync(trace)).toBe(false);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

class FakeVisibilitySleeper {
  readonly delays: number[] = [];
  sleep(delay: number): Promise<void> {
    this.delays.push(delay);
    return Promise.resolve();
  }
}

test('waits for a newly created draft without creating or uploading twice', async () => {
  const { store, github, expected } = fixture();
  const clock = new FakeVisibilitySleeper();
  github.hiddenReadsAfterCreate = 2;
  const result = await publishVerifiedCanaryRelease(expected, store, github, {
    retryDelaysMs: [1, 2],
    sleep: clock.sleep.bind(clock),
  });
  expect(result.outcome).toBe('published');
  expect(clock.delays).toEqual([1, 2]);
  expect(github.writes.map((args) => args[1])).toEqual(['create', 'upload', 'upload', 'edit']);
});

test('post-upload and publication visibility waits retain each audited asset without duplicate writes', async () => {
  const { store, github, expected } = fixture();
  const clock = new FakeVisibilitySleeper();
  github.hiddenReadsAfterCreate = 1;
  github.hiddenReadsAfterUpload = 1;
  github.hiddenReadsAfterPublish = 1;
  const result = await publishVerifiedCanaryRelease(expected, store, github, {
    retryDelaysMs: [1, 2, 3, 4],
    sleep: clock.sleep.bind(clock),
  });
  expect(result.outcome).toBe('published');
  expect(clock.delays).toEqual([1, 1, 1, 1]);
  expect(github.writes.map((args) => args[1])).toEqual(['create', 'upload', 'upload', 'edit']);
});

test.each([401, 403, 429, 500])(
  'post-create HTTP%i fails immediately without upload or a visibility delay',
  async (status) => {
    const { store, github, expected } = fixture();
    const clock = new FakeVisibilitySleeper();
    github.createdReleaseStatus = status;
    await expect(
      publishVerifiedCanaryRelease(expected, store, github, {
        retryDelaysMs: [1],
        sleep: clock.sleep.bind(clock),
      })
    ).rejects.toThrow(`received ${status}`);
    expect(github.writes.map((args) => args[1])).toEqual(['create']);
    expect(clock.delays).toEqual([]);
  }
);

test('a conflicting post-create source is never treated as a visibility delay', async () => {
  const { store, github, expected } = fixture();
  const clock = new FakeVisibilitySleeper();
  github.createdSource = 'b'.repeat(40);
  await expect(
    publishVerifiedCanaryRelease(expected, store, github, {
      retryDelaysMs: [1],
      sleep: clock.sleep.bind(clock),
    })
  ).rejects.toThrow('expected exact full source');
  expect(github.writes.map((args) => args[1])).toEqual(['create']);
  expect(clock.delays).toEqual([]);
});
