import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createWorkspaceCycleCommand } from '../lib/check';
import { ROOT_DIR, ROOT_LINT_PATHS } from '../lib/config';
import type { RunResult } from '../lib/exec';
import { listCheckoutFiles } from '../lib/git';
import { createImportCycleCommand } from '../lib/import-cycle-command';
import { listImportGraphFiles } from '../lib/import-cycles';
import { readPassStamp } from '../lib/pass-stamp';
import {
  listFrontendBoundaryPaths,
  listNodeEnvScanPaths,
  posixText,
} from '../lib/source-scan-paths';
import {
  createSourceScanStamper,
  sourceScanFacts,
  sourceScanInputDigest,
  sourceScanInputFiles,
  sourceScanTaskKey,
  workspaceLinks,
} from '../lib/source-scan-stamp';
import { canonicalPath } from './support/canonical-path';

const directories: string[] = [];

function createDirectory(prefix: string): string {
  const directory = canonicalPath(mkdtempSync(join(tmpdir(), prefix)));
  directories.push(directory);
  return directory;
}

/** A temporary Git repository holding `files`, nothing staged: every file is untracked. */
function createRepository(files: Readonly<Record<string, string>>): string {
  const root = createDirectory('mango-source-scan-stamp-');
  const init = Bun.spawnSync(['git', 'init', '-q'], { cwd: root, stderr: 'pipe' });
  expect(init.exitCode, `(git init): expected exit 0 | received: ${init.stderr}`).toBe(0);
  for (const [path, content] of Object.entries(files)) write(root, path, content);
  return root;
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** The smallest layout every scan can run on: three workspaces, a tsconfig, a lockfile. */
const BASE_FILES = {
  '.gitignore': 'build/\ndist/\nnode_modules/\n',
  'bun.lock': '{}\n',
  '.bun-version': '1.4.4\n',
  'bunfig.toml': '[test]\n',
  'package.json': '{"name":"mini"}\n',
  'tsconfig.json': '{"compilerOptions":{"module":"esnext","moduleResolution":"bundler"}}\n',
  'apps/api/src/index.ts': 'export const api = 1;\n',
  'apps/frontend/src/main.tsx': 'export const frontend = 1;\n',
  'apps/shared/src/index.ts': 'export const shared = 1;\n',
  'docs/notes.md': '# notes\n',
};

describe('sourceScanInputFiles', () => {
  test('keeps JS, TS and JSON files in any case plus the lockfile and Bun settings, and drops the rest', () => {
    const root = createDirectory('mango-source-scan-empty-');
    const checkout = [
      'apps/api/src/app.ts',
      'apps/frontend/src/main.TSX',
      'scripts/a.mts',
      'scripts/b.cjs',
      'tsconfig.jsonc',
      'apps/api/package.json',
      'bun.lock',
      '.bun-version',
      'bunfig.toml',
      'docs/guide.md',
      'crates/x/src/lib.rs',
      'apps/api/bun.lock',
    ];
    expect(sourceScanInputFiles(root, checkout)).toEqual([...checkout.slice(0, 9)].sort());
  });

  test('adds gitignored files the scans read from disk and lists each file once', () => {
    const root = createRepository({
      ...BASE_FILES,
      'apps/api/build/generated.ts': 'export {};\n',
      'apps/frontend/src/dist/inner.js': 'export {};\n',
      'apps/api/dist/out.js': 'ignored by every scan',
    });
    const keyed = sourceScanInputFiles(root);
    expect(keyed).toContain('apps/api/build/generated.ts');
    expect(keyed).toContain('apps/frontend/src/dist/inner.js');
    expect(keyed).not.toContain('apps/api/dist/out.js');
    expect(keyed).not.toContain('docs/notes.md');
    expect(new Set(keyed).size).toBe(keyed.length);
    expect(keyed).toEqual([...keyed].sort());
  });

  test('never lists the pass stamps it is keyed beside', () => {
    const root = createRepository({
      ...BASE_FILES,
      '.mango/pass-stamps/root_cycles.json': '{}',
    });
    expect(sourceScanInputFiles(root).some((file) => file.startsWith('.mango/'))).toBe(false);
  });
});

describe('workspaceLinks', () => {
  test('records workspace links and leaves out package store links and .bin', () => {
    const root = createDirectory('mango-source-scan-links-');
    mkdirSync(join(root, 'node_modules/@mangostudio'), { recursive: true });
    mkdirSync(join(root, 'node_modules/.bun/pkg@1.0.0/node_modules/pkg'), { recursive: true });
    mkdirSync(join(root, 'node_modules/.bin'));
    symlinkSync('../../apps/api', join(root, 'node_modules/@mangostudio/api'), 'junction');
    symlinkSync('../../packages/protocol', join(root, 'node_modules/@mangostudio/protocol'));
    symlinkSync('.bun/pkg@1.0.0/node_modules/pkg', join(root, 'node_modules/pkg'), 'junction');
    // Windows makes `api` a junction, and a junction reads back as the absolute
    // path of its target; the symlink keeps the relative text it was made with.
    const apiTarget =
      process.platform === 'win32' ? posixText(join(root, 'apps', 'api')) : '../../apps/api';
    expect(workspaceLinks(root)).toEqual([
      `node_modules/@mangostudio/api -> ${apiTarget}`,
      'node_modules/@mangostudio/protocol -> ../../packages/protocol',
    ]);
  });

  test('reads the node_modules of every workspace the root manifest names', () => {
    const root = createDirectory('mango-source-scan-workspace-links-');
    write(root, 'package.json', '{"workspaces":["apps/*","packages/protocol"]}\n');
    for (const workspace of ['apps/api', 'apps/frontend', 'packages/protocol']) {
      mkdirSync(join(root, workspace, 'node_modules/@mangostudio'), { recursive: true });
    }
    symlinkSync('../../../shared', join(root, 'apps/api/node_modules/@mangostudio/shared'));
    symlinkSync('../../../shared', join(root, 'apps/frontend/node_modules/@mangostudio/shared'));
    symlinkSync(
      '../../../../apps/shared',
      join(root, 'packages/protocol/node_modules/@mangostudio/shared')
    );
    // A directory no manifest entry names is not read.
    mkdirSync(join(root, 'tools/node_modules'), { recursive: true });
    symlinkSync('../../apps/api', join(root, 'tools/node_modules/stray'));
    expect(workspaceLinks(root)).toEqual([
      'apps/api/node_modules/@mangostudio/shared -> ../../../shared',
      'apps/frontend/node_modules/@mangostudio/shared -> ../../../shared',
      'packages/protocol/node_modules/@mangostudio/shared -> ../../../../apps/shared',
    ]);
  });

  test('is empty when node_modules does not exist', () => {
    expect(workspaceLinks(createDirectory('mango-source-scan-nolinks-'))).toEqual([]);
  });
});

describe('sourceScanFacts', () => {
  test('records the Bun build, the host, the workspace links and the listed sources', () => {
    const root = createDirectory('mango-source-scan-facts-');
    expect(sourceScanFacts(root, ['b.ts', 'a.tsx', 'c.json', 'd.md', 'e.mjs'])).toEqual({
      bun: `${Bun.version} ${Bun.revision}`,
      host: `${process.platform} ${process.arch}`,
      workspaceLinks: '[]',
      listedSources: JSON.stringify(['a.tsx', 'b.ts', 'e.mjs']),
      symlinks: '[]',
    });
  });
});

describe('sourceScanInputDigest', () => {
  test('is the same for the same tree, and for a changed non-source file', () => {
    const root = createRepository(BASE_FILES);
    const before = sourceScanInputDigest(root);
    expect(sourceScanInputDigest(root)).toBe(before);
    write(root, 'docs/notes.md', '# edited\n');
    write(root, 'crates/x/src/lib.rs', 'fn main() {}\n');
    expect(sourceScanInputDigest(root)).toBe(before);
  });

  /** Each case edits one thing a scan can read and expects a different digest. */
  const EDITS: ReadonlyArray<readonly [string, (root: string) => void]> = [
    [
      'a .ts file under a scanned root changes',
      (root) => write(root, 'apps/api/src/index.ts', 'export const api = 2;\n'),
    ],
    [
      'a file in another workspace changes',
      (root) => write(root, 'apps/shared/src/index.ts', 'export const shared = 2;\n'),
    ],
    [
      'a tsconfig changes',
      (root) => write(root, 'tsconfig.json', '{"compilerOptions":{"paths":{"@x/*":["./x/*"]}}}\n'),
    ],
    [
      'an untracked source file appears',
      (root) => write(root, 'apps/api/src/new.ts', 'export {};\n'),
    ],
    [
      'an untracked file appears outside the scanned roots',
      (root) => write(root, 'tools/new.mts', 'export {};\n'),
    ],
    [
      'a gitignored source file appears',
      (root) => write(root, 'apps/api/build/generated.ts', 'export {};\n'),
    ],
    [
      'a gitignored source file appears in an unscanned workspace',
      (root) => write(root, 'apps/shared/build/generated.ts', 'export {};\n'),
    ],
    ['a source file is deleted', (root) => rmSync(join(root, 'apps/shared/src/index.ts'))],
    [
      'a package manifest changes',
      (root) => write(root, 'package.json', '{"name":"mini","type":"module"}\n'),
    ],
    ['the lockfile changes', (root) => write(root, 'bun.lock', '{"lockfileVersion":1}\n')],
    ['the Bun version file changes', (root) => write(root, '.bun-version', '1.4.5\n')],
    ['bunfig.toml changes', (root) => write(root, 'bunfig.toml', '[test]\npreload = []\n')],
    [
      'a JSON file a tsconfig could extend appears',
      (root) => write(root, 'config/base.json', '{}\n'),
    ],
    [
      'a workspace node_modules link appears',
      (root) => {
        write(root, 'package.json', '{"name":"mini","workspaces":["apps/*"]}\n');
        mkdirSync(join(root, 'apps/api/node_modules/@mangostudio'), { recursive: true });
        symlinkSync('../../../shared', join(root, 'apps/api/node_modules/@mangostudio/shared'));
      },
    ],
    [
      'a workspace link points somewhere else',
      (root) => {
        mkdirSync(join(root, 'node_modules/@mangostudio'), { recursive: true });
        symlinkSync('../../apps/shared', join(root, 'node_modules/@mangostudio/shared'));
      },
    ],
  ];

  test('a retargeted symlinked directory under a source tree changes the digest', () => {
    // The case a review reproduced: apps/api/src/vendor points at one tree and
    // then another; no file the key hashes changes, but the import graph does.
    const root = createRepository({
      ...BASE_FILES,
      'apps/api/src/index.ts': "export * from './vendor/x';\n",
      'apps/shared/src/x.ts': 'export const x = 1;\n',
      'apps/frontend/src/x.ts': "import '../../api/src/index';\nexport const x = 2;\n",
    });
    const link = join(root, 'apps/api/src/vendor');
    symlinkSync('../../shared/src', link);
    const before = sourceScanInputDigest(root);
    expect(sourceScanInputDigest(root)).toBe(before);
    rmSync(link);
    symlinkSync('../../frontend/src', link);
    expect(
      sourceScanInputDigest(root),
      '(source scan digest): expected a different digest after retargeting apps/api/src/vendor | received: unchanged'
    ).not.toBe(before);
  });

  test('a workspace link that is retargeted changes the digest', () => {
    const root = createRepository({
      ...BASE_FILES,
      'package.json': '{"name":"mini","workspaces":["apps/*"]}\n',
    });
    mkdirSync(join(root, 'apps/api/node_modules/@mangostudio'), { recursive: true });
    const link = join(root, 'apps/api/node_modules/@mangostudio/shared');
    symlinkSync('../../../shared', link);
    const before = sourceScanInputDigest(root);
    rmSync(link);
    symlinkSync('../../../frontend', link);
    expect(
      sourceScanInputDigest(root),
      '(source scan digest): expected a different digest after retargeting a workspace link | received: unchanged'
    ).not.toBe(before);
  });

  test('an ignored source file that becomes Git-listed changes the digest', () => {
    // shared-import-boundary reads only Git-listed files; the bytes and the disk
    // walk are the same before and after, so the listing alone has to move the key.
    const root = createRepository({
      ...BASE_FILES,
      '.gitignore': 'gen/\nbuild/\ndist/\nnode_modules/\n',
      'gen/x.ts': "import '@mangostudio/shared';\n",
    });
    const ignored = sourceScanInputDigest(root);
    write(root, '.gitignore', 'build/\ndist/\nnode_modules/\n');
    expect(
      sourceScanInputDigest(root),
      '(source scan digest): expected a different digest once gen/x.ts is listed by Git | received: unchanged'
    ).not.toBe(ignored);
  });

  test('forcing an ignored source file into the index changes the digest', () => {
    const root = createRepository({
      ...BASE_FILES,
      'gen/x.ts': "import '@mangostudio/shared';\n",
      '.gitignore': 'gen/\nbuild/\ndist/\nnode_modules/\n',
    });
    const ignored = sourceScanInputDigest(root);
    const added = Bun.spawnSync(['git', 'add', '-f', 'gen/x.ts'], { cwd: root, stderr: 'pipe' });
    expect(added.exitCode, `(git add -f): expected exit 0 | received: ${added.stderr}`).toBe(0);
    expect(
      sourceScanInputDigest(root),
      '(source scan digest): expected a different digest once gen/x.ts is tracked | received: unchanged'
    ).not.toBe(ignored);
  });

  test.each(EDITS)('changes when %s', (name, edit) => {
    const root = createRepository(BASE_FILES);
    const before = sourceScanInputDigest(root);
    edit(root);
    expect(
      sourceScanInputDigest(root),
      `(source scan digest): expected a different digest after: ${name} | received: unchanged`
    ).not.toBe(before);
  });
});

describe('sourceScanTaskKey', () => {
  const COMMAND = ['bun', 'scripts/check-import-cycles.ts', 'apps/api'];
  const DIGEST = 'a'.repeat(64);

  test('is a SHA-256 that depends on both the digest and the command', () => {
    const root = createDirectory('mango-source-scan-key-');
    const key = sourceScanTaskKey(root, DIGEST, COMMAND);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(sourceScanTaskKey(root, DIGEST, COMMAND)).toBe(key);
    expect(sourceScanTaskKey(root, 'b'.repeat(64), COMMAND)).not.toBe(key);
    expect(sourceScanTaskKey(root, DIGEST, [...COMMAND.slice(0, 2), 'apps/shared'])).not.toBe(key);
  });
});

/** A scan standing in for a command: counts its runs and can edit inputs while it runs. */
class FakeScan {
  starts = 0;
  duringRun: () => void = () => undefined;
  constructor(
    readonly label: string,
    private readonly exitCode = 0
  ) {}
  run = (): Promise<RunResult> => {
    this.starts += 1;
    this.duringRun();
    return Promise.resolve({ label: this.label, exitCode: this.exitCode, duration: 5 });
  };
}

/** Stands in for the input digest: counts calls and returns whatever it is told to. */
class FakeDigest {
  calls = 0;
  value = 'inputs-one';
  take = (): string => {
    this.calls += 1;
    return this.value;
  };
}

class FakeReport {
  lines: string[] = [];
  write = (message: string): void => {
    this.lines.push(message);
  };
}

describe('createSourceScanStamper', () => {
  const COMMAND = ['bun', 'scripts/check-import-cycles.ts', 'apps/api'];

  function setup(enabled = true) {
    const rootDir = createDirectory('mango-source-scan-stamper-root-');
    const stampDir = join(createDirectory('mango-source-scan-stamper-stamps-'), 'stamps');
    const digest = new FakeDigest();
    const report = new FakeReport();
    const stamp = createSourceScanStamper({
      rootDir,
      stampDir,
      enabled,
      inputDigest: digest.take,
      report: report.write,
    });
    return { stamp, digest, report, stampDir };
  }

  test('runs a scan once, then replays it while the inputs match', async () => {
    const { stamp, digest, report } = setup();
    const scan = new FakeScan('api:cycles');
    const first = await stamp(scan.label, COMMAND, scan.run)();
    const second = await stamp(scan.label, COMMAND, scan.run)();
    expect(scan.starts).toBe(1);
    expect(first.label).toBe('api:cycles');
    expect(second.label).toMatch(/^api:cycles \(replayed [0-9a-f]{12}\)$/);
    expect(second.exitCode).toBe(0);
    expect(report.lines).toHaveLength(1);
    expect(digest.calls).toBe(3);
  });

  test('runs again when the inputs changed since the pass', async () => {
    const { stamp, digest } = setup();
    const scan = new FakeScan('api:cycles');
    await stamp(scan.label, COMMAND, scan.run)();
    digest.value = 'inputs-two';
    const again = await stamp(scan.label, COMMAND, scan.run)();
    expect(scan.starts).toBe(2);
    expect(again.label).toBe('api:cycles');
  });

  test('a scan with another command does not replay this one', async () => {
    const { stamp } = setup();
    const scan = new FakeScan('api:cycles');
    await stamp(scan.label, COMMAND, scan.run)();
    await stamp(scan.label, [...COMMAND.slice(0, 2), 'apps/shared'], scan.run)();
    expect(scan.starts).toBe(2);
  });

  test('scans started together share one before digest', async () => {
    const { stamp, digest } = setup();
    const scans = ['api:cycles', 'shared:cycles', 'root:cycles'].map(
      (label) => new FakeScan(label)
    );
    const seenAtStart: number[] = [];
    for (const scan of scans) scan.duringRun = () => seenAtStart.push(digest.calls);
    await Promise.all(scans.map((scan) => stamp(scan.label, COMMAND, scan.run)()));
    expect(
      seenAtStart,
      '(source scan stamper): expected every scan to start after exactly 1 digest'
    ).toEqual([1, 1, 1]);
    expect(scans.map((scan) => scan.starts)).toEqual([1, 1, 1]);
    // Scans that end in the same turn share one after digest.
    expect(digest.calls).toBeLessThan(2 * scans.length);
  });

  test('takes the after digest only once the scan has ended', async () => {
    const { stamp, digest } = setup();
    const scan = new FakeScan('api:cycles');
    const observed: number[] = [];
    scan.duringRun = () => observed.push(digest.calls);
    await stamp(scan.label, COMMAND, scan.run)();
    expect(observed).toEqual([1]);
    expect(digest.calls).toBe(2);
  });

  test('an edit made while the scan ran is not credited to it', async () => {
    const { stamp, digest, report, stampDir } = setup();
    const scan = new FakeScan('api:cycles');
    scan.duringRun = () => {
      digest.value = 'inputs-edited-mid-run';
    };
    const result = await stamp(scan.label, COMMAND, scan.run)();
    expect(result.exitCode).toBe(0);
    expect(readPassStamp(stampDir, scan.label)).toBeNull();
    expect(report.lines[0]).toMatch(/inputs changed during the run/);
  });

  test('a failing scan leaves no stamp', async () => {
    const { stamp, stampDir } = setup();
    const scan = new FakeScan('api:cycles', 1);
    expect((await stamp(scan.label, COMMAND, scan.run)()).exitCode).toBe(1);
    expect(readPassStamp(stampDir, scan.label)).toBeNull();
    await stamp(scan.label, COMMAND, scan.run)();
    expect(scan.starts).toBe(2);
  });

  test('disabled, it never takes a digest and never replays', async () => {
    const { stamp, digest, stampDir } = setup(false);
    const scan = new FakeScan('api:cycles');
    await stamp(scan.label, COMMAND, scan.run)();
    await stamp(scan.label, COMMAND, scan.run)();
    expect(scan.starts).toBe(2);
    expect(digest.calls).toBe(0);
    expect(readPassStamp(stampDir, scan.label)).toBeNull();
  });

  test('a digest that cannot be taken is a miss: the scan runs, the reason is reported once, no stamp is written', async () => {
    const { report, stampDir } = setup();
    const failing = createSourceScanStamper({
      rootDir: createDirectory('mango-source-scan-stamper-failure-'),
      stampDir,
      enabled: true,
      inputDigest: () => {
        throw new Error('git ls-files failed');
      },
      report: report.write,
    });
    const scans = [new FakeScan('api:cycles'), new FakeScan('shared:cycles')];
    const results = await Promise.all(
      scans.map((scan) => failing(scan.label, COMMAND, scan.run)())
    );
    expect(scans.map((scan) => scan.starts)).toEqual([1, 1]);
    expect(results.map((result) => result.exitCode)).toEqual([0, 0]);
    expect(results.map((result) => result.label)).toEqual(['api:cycles', 'shared:cycles']);
    expect(
      report.lines,
      `(source scan stamper): expected one miss report | received: ${report.lines.length}`
    ).toEqual([
      '  source scans run without pass stamps: expected the scan inputs to be readable | received: git ls-files failed',
    ]);
    expect(readPassStamp(stampDir, 'api:cycles')).toBeNull();
  });

  test('a failing scan keeps its exit code when the digest cannot be taken', async () => {
    const { report, stampDir } = setup();
    const stamp = createSourceScanStamper({
      rootDir: stampDir,
      stampDir,
      enabled: true,
      inputDigest: () => {
        throw new Error('EACCES');
      },
      report: report.write,
    });
    const scan = new FakeScan('api:cycles', 1);
    expect((await stamp(scan.label, COMMAND, scan.run)()).exitCode).toBe(1);
    expect(scan.starts).toBe(1);
  });

  test('a digest that fails only after the run keeps that run result and records no stamp', async () => {
    const { report, stampDir } = setup();
    let calls = 0;
    const stamp = createSourceScanStamper({
      rootDir: stampDir,
      stampDir,
      enabled: true,
      inputDigest: () => {
        calls += 1;
        if (calls > 1) throw new Error('directory vanished');
        return 'inputs-one';
      },
      report: report.write,
    });
    const scan = new FakeScan('api:cycles');
    const result = await stamp(scan.label, COMMAND, scan.run)();
    expect(scan.starts, '(source scan stamper): expected exactly one run').toBe(1);
    expect(result).toMatchObject({ label: 'api:cycles', exitCode: 0 });
    expect(readPassStamp(stampDir, scan.label)).toBeNull();
    expect(report.lines).toHaveLength(1);
  });

  // Root reads any directory, and Windows has no mode bits to make one unreadable.
  test.skipIf(process.getuid?.() === 0 || process.platform === 'win32')(
    'an unreadable directory in the checkout is a miss, not a failed check',
    async () => {
      const root = createRepository({
        ...BASE_FILES,
        '.gitignore': 'locked/\nbuild/\ndist/\nnode_modules/\n',
        'locked/secret.ts': 'export const secret = 1;\n',
      });
      const locked = join(root, 'locked');
      chmodSync(locked, 0o000);
      try {
        const report = new FakeReport();
        const stampDir = join(root, '.mango/pass-stamps');
        const stamp = createSourceScanStamper({
          rootDir: root,
          stampDir,
          enabled: true,
          report: report.write,
        });
        const scan = new FakeScan('api:cycles');
        const result = await stamp(scan.label, COMMAND, scan.run)();
        expect(result).toMatchObject({ label: 'api:cycles', exitCode: 0 });
        expect(scan.starts).toBe(1);
        expect(readPassStamp(stampDir, scan.label)).toBeNull();
        expect(
          report.lines.join('\n'),
          `(source scan stamper): expected the miss report to name EACCES | received: ${report.lines.join('\n')}`
        ).toContain('EACCES');
      } finally {
        chmodSync(locked, 0o755);
      }
    }
  );
});

describe('the key covers every file the scans read in this repository', () => {
  // Every cycle scan's roots, taken from the commands `check.ts` builds. One
  // graph over their union reads a superset of what each scan reads alone.
  const CYCLE_ROOTS = [
    ...(['frontend', 'api', 'shared'] as const).flatMap((workspace) =>
      createWorkspaceCycleCommand(workspace).slice(2)
    ),
    ...createImportCycleCommand(ROOT_LINT_PATHS).slice(2),
  ];

  function missingFrom(keyed: ReadonlySet<string>, files: readonly string[]): string[] {
    return files.filter((file) => !keyed.has(file));
  }

  test('every file a cycle scan walks or resolves an import to is keyed', () => {
    const keyed = new Set(sourceScanInputFiles(ROOT_DIR));
    const read = listImportGraphFiles(CYCLE_ROOTS, ROOT_DIR);
    expect(read.length, '(cycle scans): expected files | received none').toBeGreaterThan(0);
    const missing = missingFrom(keyed, read);
    expect(
      missing,
      `(source scan stamp): expected every file the cycle scans read in the key | received: ${missing[0]}`
    ).toEqual([]);
  }, 30_000);

  test('the cycle scans reach other workspaces through node_modules links', () => {
    // The reason one wide key serves all scans: apps/api imports apps/shared by package name.
    const read = new Set(listImportGraphFiles(['apps/api'], ROOT_DIR));
    expect(
      [...read].some((file) => file.startsWith('apps/shared/')),
      '(cycle scan apps/api): expected files in apps/shared | received: none'
    ).toBe(true);
  });

  test('every file the NODE_ENV scan reads is keyed', () => {
    const keyed = new Set(sourceScanInputFiles(ROOT_DIR));
    const read = listNodeEnvScanPaths(ROOT_DIR);
    expect(read.length).toBeGreaterThan(0);
    const missing = missingFrom(keyed, read);
    expect(
      missing,
      `(source scan stamp): expected every NODE_ENV scan file in the key | received: ${missing[0]}`
    ).toEqual([]);
  });

  test('every file the frontend API import scan reads is keyed', () => {
    const keyed = new Set(sourceScanInputFiles(ROOT_DIR));
    const read = listFrontendBoundaryPaths(ROOT_DIR);
    expect(read.length).toBeGreaterThan(0);
    const missing = missingFrom(keyed, read);
    expect(
      missing,
      `(source scan stamp): expected every frontend import scan file in the key | received: ${missing[0]}`
    ).toEqual([]);
  });

  test('every Git-visible source file the shared root import scan reads is keyed', () => {
    const keyed = new Set(sourceScanInputFiles(ROOT_DIR));
    const read = listCheckoutFiles(ROOT_DIR).filter((file) =>
      /\.(?:[cm]?[jt]s|[jt]sx)$/.test(file)
    );
    expect(read.length).toBeGreaterThan(0);
    const missing = missingFrom(keyed, read);
    expect(
      missing,
      `(source scan stamp): expected every shared root import scan file in the key | received: ${missing[0]}`
    ).toEqual([]);
  });
});

describe('a stamped cycle scan in a miniature repository', () => {
  /**
   * A repository the real cycle scan can run in: the scripts library, the entry
   * script, three workspaces, and the TypeScript package linked from this checkout.
   */
  function createMiniature(): string {
    const root = createRepository({
      ...BASE_FILES,
      'apps/api/package.json': '{"name":"@mangostudio/api"}\n',
      'apps/shared/package.json':
        '{"name":"@mangostudio/shared","exports":{"./leaf":"./src/leaf.ts","./loop":"./src/loop.ts"}}\n',
      'apps/shared/src/leaf.ts': 'export const leaf = 1;\n',
      'apps/api/src/index.ts':
        "import { leaf } from '@mangostudio/shared/leaf';\nexport const api = leaf;\n",
    });
    cpSync(join(ROOT_DIR, 'scripts/lib'), join(root, 'scripts/lib'), { recursive: true });
    cpSync(
      join(ROOT_DIR, 'scripts/check-import-cycles.ts'),
      join(root, 'scripts/check-import-cycles.ts')
    );
    mkdirSync(join(root, 'node_modules/@mangostudio'), { recursive: true });
    symlinkSync('../../apps/api', join(root, 'node_modules/@mangostudio/api'));
    symlinkSync('../../apps/shared', join(root, 'node_modules/@mangostudio/shared'));
    for (const name of ['@typescript', '.bun']) {
      symlinkSync(join(ROOT_DIR, 'node_modules', name), join(root, 'node_modules', name));
    }
    return root;
  }

  /** The real cycle scan as a subprocess, the way `check.ts` spawns it. */
  const realCycleScan =
    (label: string, command: readonly string[], cwd: string) => async (): Promise<RunResult> => {
      const started = Date.now();
      const child = Bun.spawn([...command], { cwd, stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      lastScanOutput = stdout + stderr;
      return { label, exitCode, duration: Date.now() - started };
    };
  let lastScanOutput = '';

  /** One check pass over `apps/api`, stamped, with stamps on whatever `CI` says. */
  async function checkApi(root: string): Promise<RunResult> {
    const command = ['bun', 'scripts/check-import-cycles.ts', 'apps/api'];
    const stamp = createSourceScanStamper({
      rootDir: root,
      stampDir: join(root, '.mango/pass-stamps'),
      enabled: true,
      report: new FakeReport().write,
    });
    return stamp('api:cycles', command, realCycleScan('api:cycles', command, root))();
  }

  test('replays a pass, then runs and fails once a gitignored cycle appears', async () => {
    const root = createMiniature();
    const first = await checkApi(root);
    expect(first, `(api:cycles): expected a pass | received: ${lastScanOutput}`).toMatchObject({
      label: 'api:cycles',
      exitCode: 0,
    });

    const replayed = await checkApi(root);
    expect(replayed.label, '(api:cycles): expected a replay on unchanged inputs').toMatch(
      /replayed/
    );

    write(root, 'apps/api/build/a.ts', "import './b';\n");
    write(root, 'apps/api/build/b.ts', "import './a';\n");
    const rejected = await checkApi(root);
    expect(rejected.label, '(api:cycles): expected the scan to run, not replay').toBe('api:cycles');
    expect(
      rejected.exitCode,
      `(api:cycles): expected exit 1 | received: ${rejected.exitCode}`
    ).toBe(1);
    expect(lastScanOutput).toContain('import/no-cycle');
    expect(lastScanOutput.replaceAll('\\', '/')).toContain('apps/api/build/a.ts');
  }, 60_000);

  test('a cycle closed from another workspace is caught on the next run', async () => {
    const root = createMiniature();
    expect((await checkApi(root)).exitCode).toBe(0);
    expect((await checkApi(root)).label).toMatch(/replayed/);

    // apps/api imports @mangostudio/shared/leaf; make that file import apps/api back.
    write(
      root,
      'apps/shared/src/leaf.ts',
      "import { api } from '@mangostudio/api/src/index';\nexport const leaf = api;\n"
    );
    write(
      root,
      'apps/api/package.json',
      '{"name":"@mangostudio/api","exports":{"./src/index":"./src/index.ts"}}\n'
    );
    const rejected = await checkApi(root);
    expect(rejected.exitCode, `(api:cycles): expected exit 1 | received: ${lastScanOutput}`).toBe(
      1
    );
    expect(lastScanOutput).toContain('import/no-cycle');
  }, 60_000);

  test('a symlinked directory retargeted to a tree that closes a cycle is caught on the next run', async () => {
    const root = createMiniature();
    write(root, 'apps/api/src/index.ts', "export * from './vendor/x';\n");
    write(root, 'apps/shared/src/x.ts', 'export const x = 1;\n');
    write(root, 'apps/frontend/src/x.ts', "import '../../api/src/index';\nexport const x = 2;\n");
    const link = join(root, 'apps/api/src/vendor');
    symlinkSync('../../shared/src', link);
    expect((await checkApi(root)).exitCode, lastScanOutput).toBe(0);
    expect((await checkApi(root)).label).toMatch(/replayed/);

    rmSync(link);
    symlinkSync('../../frontend/src', link);
    const rejected = await checkApi(root);
    expect(rejected.label, '(api:cycles): expected the scan to run, not replay').toBe('api:cycles');
    expect(
      rejected.exitCode,
      `(api:cycles): expected exit 1 after retargeting apps/api/src/vendor | received: ${lastScanOutput}`
    ).toBe(1);
    expect(lastScanOutput).toContain('import/no-cycle');
  }, 60_000);

  test('an untracked source file that completes a cycle is caught on the next run', async () => {
    const root = createMiniature();
    write(root, 'apps/api/src/first.ts', "import './second';\n");
    expect((await checkApi(root)).exitCode).toBe(0);
    expect((await checkApi(root)).label).toMatch(/replayed/);
    write(root, 'apps/api/src/second.ts', "import './first';\n");
    expect((await checkApi(root)).exitCode).toBe(1);
  }, 60_000);
});
