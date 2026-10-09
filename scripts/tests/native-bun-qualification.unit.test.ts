import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  nativeQualificationEnvironment,
  parseNativeQualificationArgs,
  runNativeQualification,
} from '../lib/native-bun-qualification';
import type {
  NativeCommandOptions,
  NativeCommandReceipt,
  NativeProcess,
} from '../lib/native-bun-qualification-process';
import {
  collectNativeTestEvidence,
  type NativeTestLane,
  nativeTestInventory,
} from '../lib/native-bun-qualification-results';
import {
  nativeCompilerArtifacts,
  nativeSourceChanged,
  sealNativeArtifact,
  sealNativeSource,
} from '../lib/native-bun-qualification-source';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function file(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

function git(root: string, args: readonly string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`fixture git ${args[0]}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

async function checkout(): Promise<{ root: string; out: string; sha: string }> {
  const base = await mkdtemp(join(tmpdir(), 'native-qualification-'));
  temporary.push(base);
  const root = join(base, 'source');
  await mkdir(root);
  await file(
    join(root, 'package.json'),
    JSON.stringify({
      packageManager: 'bun@1.4.2',
      scripts: {
        test: 'bun ./scripts/test.ts',
        'test:scripts':
          'mkdir -p .mango/artifacts/junit && bun test --timeout 15000 --reporter=junit --reporter-outfile=.mango/artifacts/junit/root.xml $MANGOSTUDIO_BUN_TEST_ARGS scripts',
      },
    })
  );
  await file(
    join(root, 'scripts/test.ts'),
    "// !hasExplicitLaneSelection || runUnitLane\n// !hasExplicitLaneSelection || runIntegrationLane\n// workspaceLaneTasks('test:unit')\n// workspaceLaneTasks('test:integration')\n"
  );
  await file(
    join(root, 'scripts/lib/config.ts'),
    "export const ALL_WORKSPACE_NAMES = ['frontend', 'api', 'shared'];\n"
  );
  await file(join(root, 'scripts/root.test.ts'), '// tracked root test\n');
  await file(join(root, 'packages/protocol/protocol.test.ts'), '// tracked protocol test\n');
  await file(join(root, '.gitignore'), 'node_modules/\n.turbo/\n.mango/artifacts/\n');
  const scripts = {
    api: {
      'test:unit':
        'MANGOSTUDIO_DIAGNOSTIC_LOGS=0 bun ../../scripts/with-test-home.ts bun test --timeout 15000 --parallel=1 tests/unit',
      'test:integration':
        'MANGOSTUDIO_DIAGNOSTIC_LOGS=0 bun ../../scripts/with-test-home.ts bun test --timeout 15000 tests/integration',
    },
    shared: { 'test:unit': 'bun test --timeout 15000 tests/unit' },
    frontend: {
      'test:unit':
        'bun test --tsconfig-override=./tsconfig.test.json --parallel=4 --isolate --timeout 15000 tests/unit',
      'test:integration':
        'bun test --tsconfig-override=./tsconfig.test.json --parallel=4 --isolate --timeout 15000 tests/integration',
    },
  };
  for (const workspace of ['api', 'shared', 'frontend'] as const) {
    await file(
      join(root, `apps/${workspace}/package.json`),
      JSON.stringify({
        scripts: scripts[workspace],
      })
    );
    await file(join(root, `apps/${workspace}/tests/unit/unit.test.ts`), '// tracked unit test\n');
    if (workspace !== 'shared')
      await file(
        join(root, `apps/${workspace}/tests/integration/integration.test.ts`),
        '// tracked integration test\n'
      );
  }
  git(root, ['init', '-q']);
  git(root, ['config', 'core.autocrlf', 'false']);
  git(root, ['add', '.']);
  git(root, [
    '-c',
    'user.name=Qualification fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--no-verify',
    '-qm',
    'test: qualification fixture',
  ]);
  return { root, out: join(base, 'receipts'), sha: git(root, ['rev-parse', 'HEAD']) };
}

async function emptyNativeCensus(): Promise<NativeProcess[]> {
  await Promise.resolve();
  return [];
}

class FakeNativeCommands {
  readonly calls: NativeCommandOptions[] = [];
  checkExit = 0;
  installExit = 0;
  omitIntegration = false;
  mutateSource = false;
  mutateArtifact = false;
  unobservedLabel: string | null = null;
  sdkFeatures: Record<'runtime' | 'fake', readonly string[]> = {
    runtime: ['stdio'],
    fake: ['stdio', 'testing'],
  };
  primaryFeatures: Record<'runtime' | 'fake', readonly string[]> = { runtime: [], fake: [] };

  run = async (options: NativeCommandOptions): Promise<NativeCommandReceipt> => {
    this.calls.push(options);
    let content = '';
    if (options.label === 'bun-revision') content = '1.4.2+744846f84\n';
    if (options.label === 'rustc-version') content = 'rustc 1.99.0\n';
    if (options.label === 'cargo-version') content = 'cargo 1.99.0\n';
    if (options.label === 'cargo-normal-tree') content = 'mangostudio-runtime v0.1.1\n';
    if (options.label.startsWith('build-')) {
      const target = options.env.CARGO_TARGET_DIR;
      if (!target) throw new Error('fake build expected its own target directory');
      const suffix = process.platform === 'win32' ? '.exe' : '';
      const path =
        options.label === 'build-runtime'
          ? `debug/mangostudio-runtime${suffix}`
          : `debug/examples/fake_cursor_agent${suffix}`;
      await file(join(target, path), options.label);
      const build = options.label === 'build-runtime' ? 'runtime' : 'fake';
      const rows = [
        {
          reason: 'compiler-artifact',
          package_id: 'mango-external-agents',
          target: { name: 'mango_external_agents', kind: ['lib'] },
          features: this.sdkFeatures[build],
          executable: null,
          filenames: [],
        },
        {
          reason: 'compiler-artifact',
          package_id: 'mangostudio-runtime',
          target: {
            name: build === 'runtime' ? 'mangostudio-runtime' : 'fake_cursor_agent',
            kind: [build === 'runtime' ? 'bin' : 'example'],
          },
          features: this.primaryFeatures[build],
          executable: join(target, path),
          filenames: [join(target, path)],
        },
        { reason: 'build-finished', success: true },
      ];
      content = `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
    }
    if (options.label === 'check' && this.mutateSource)
      await file(
        join(options.root, 'scripts/root.test.ts'),
        '// mutation hidden from command exit\n'
      );
    if (options.label === 'test') {
      const seal = await sealNativeSource(options.root);
      const lanes = await nativeTestInventory(
        options.root,
        seal.files.map((entry) => entry.path)
      );
      content = testLog(lanes, this.omitIntegration);
      await file(
        join(options.root, '.mango/artifacts/junit/root.xml'),
        '<testsuites tests="1"><testcase file="scripts/root.test.ts" name="root case" /></testsuites>'
      );
      if (this.mutateArtifact && options.env.MANGOSTUDIO_RUNTIME_BINARY)
        await file(options.env.MANGOSTUDIO_RUNTIME_BINARY, 'changed runtime bytes');
    }
    await file(join(options.out, `logs/${options.label}.log`), content);
    await file(join(options.out, `logs/${options.label}.stdout.log`), content);
    return {
      label: options.label,
      command: options.command,
      environment: {},
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 0,
      exitCode:
        options.label === 'check'
          ? this.checkExit
          : options.label === 'install'
            ? this.installExit
            : 0,
      signal: null,
      timedOut: false,
      timeoutSeconds: options.timeoutSeconds,
      errors: [],
      log: `logs/${options.label}.log`,
      settlement: {
        scope: 'observed descendants and command process group',
        rootObserved: options.label !== this.unobservedLabel,
        pollIntervalMs: 1_000,
        observed: [],
        survivors: [],
        snapshotErrors: [],
        empty: true,
      },
    };
  };
}

function testLog(lanes: readonly NativeTestLane[], omitIntegration = false): string {
  return lanes
    .filter((lane) => !omitIntegration || !lane.id.endsWith('integration'))
    .map((lane) => {
      const prefix = lane.task ? `${lane.task}: ` : '';
      const path = lane.cwd ? lane.files[0].slice(lane.cwd.length + 1) : lane.files[0];
      return `${prefix}${path}:\n${prefix}(pass) ${lane.id} case [1.00ms]\n${prefix}1 pass\n${prefix}0 fail\n${prefix}Ran 1 test across 1 file. [1.00ms]\n`;
    })
    .join('');
}

describe('qualification inputs and seals', () => {
  test('retains compiled Cargo features and rejects incomplete compiler receipts', () => {
    const artifact = {
      reason: 'compiler-artifact',
      package_id: 'registry#sdk@0.3.2',
      target: { name: 'sdk', kind: ['lib'] },
      features: ['default', 'testing'],
      executable: null,
      filenames: ['sdk.rlib'],
    };
    const json = `${JSON.stringify(artifact)}\n${JSON.stringify({ reason: 'build-finished', success: true })}\n`;
    expect(nativeCompilerArtifacts(json)[0].features).toEqual(['default', 'testing']);
    expect(() => nativeCompilerArtifacts(JSON.stringify(artifact))).toThrow(
      'Missing or truncated Cargo build receipt'
    );
    expect(() => nativeCompilerArtifacts('{"reason":"compiler-artifact"}')).toThrow(
      'expected package, target, features'
    );
  });
  test('requires full SHA and distinct flag values', () => {
    expect(
      parseNativeQualificationArgs(['--root=source', '--out=receipts', '--sha', 'a'.repeat(40)]).sha
    ).toBe('a'.repeat(40));
    expect(() => parseNativeQualificationArgs(['--root', 'source'])).toThrow(
      'Missing --root or --out'
    );
    expect(() =>
      parseNativeQualificationArgs(['--root', 'source', '--out', 'receipts', '--sha', 'deadbeef'])
    ).toThrow('full 40-character');
    expect(() =>
      parseNativeQualificationArgs(['--root', 'source', '--root', 'other', '--out', 'receipts'])
    ).toThrow('expected one --root');
  });

  test('clears inherited subset/cache/Cargo configuration while retaining PATH', () => {
    const env = nativeQualificationEnvironment({
      PATH: '/fixture/path',
      MANGOSTUDIO_BUN_TEST_ARGS: '--shard=1/8',
      MANGO_TEST_WORKERS: '8',
      MANGOSTUDIO_RUNTIME_BINARY: '/old/runtime',
      TURBO_TOKEN: 'private',
      TURBO_FORCE: 'false',
      RUSTFLAGS: '--cfg old',
      CARGO_TARGET_DIR: '/old/target',
      DATABASE_PATH: '/old/database',
    });
    expect(env.PATH).toBe('/fixture/path');
    expect(env.TURBO_FORCE).toBe('true');
    expect(env.MANGOSTUDIO_BUN_TEST_ARGS).toBe('');
    for (const key of [
      'MANGOSTUDIO_RUNTIME_BINARY',
      'TURBO_TOKEN',
      'RUSTFLAGS',
      'CARGO_TARGET_DIR',
      'DATABASE_PATH',
      'MANGO_TEST_WORKERS',
    ])
      expect(env[key]).toBeUndefined();
  });

  test('detects tracked byte and executable mutations independently of HEAD', async () => {
    const source = await checkout();
    const before = await sealNativeSource(source.root);
    expect(before.head).toBe(source.sha);
    expect(before.status).toBe('');
    expect(nativeSourceChanged(before, await sealNativeSource(source.root))).toBe(false);
    await file(join(source.root, 'scripts/root.test.ts'), '// tracked root test\r\n');
    const after = await sealNativeSource(source.root);
    expect(after.head).toBe(before.head);
    expect(nativeSourceChanged(before, after)).toBe(true);
    const binary = join(source.out, 'binary');
    await file(binary, 'before');
    const artifact = await sealNativeArtifact(binary);
    await file(binary, 'after');
    expect((await sealNativeArtifact(binary)).sha256).not.toBe(artifact.sha256);
  });

  test('seals tracked symlink text and rejects a replacement with regular file bytes', async () => {
    const source = await checkout();
    const link = join(source.root, 'tracked-link');
    git(source.root, ['config', 'core.symlinks', 'true']);
    await symlink('scripts/root.test.ts', link);
    git(source.root, ['add', 'tracked-link']);
    const seal = await sealNativeSource(source.root);
    expect(seal.files.find((entry) => entry.path === 'tracked-link')?.mode).toBe('120000');
    expect(seal.files.find((entry) => entry.path === 'tracked-link')?.bytes).toBe(
      Buffer.byteLength('scripts/root.test.ts')
    );
    await rm(link);
    await file(link, 'scripts/root.test.ts');
    await expect(sealNativeSource(source.root)).rejects.toThrow(
      'expected filesystem symlink matching Git mode 120000'
    );
  });

  test('inventories all seven default lanes and rejects source producer drift', async () => {
    const source = await checkout();
    const seal = await sealNativeSource(source.root);
    const lanes = await nativeTestInventory(
      source.root,
      seal.files.map((entry) => entry.path)
    );
    expect(lanes.map((lane) => lane.id)).toEqual([
      'root',
      'protocol',
      'api-unit',
      'shared-unit',
      'frontend-unit',
      'api-integration',
      'frontend-integration',
    ]);
    await file(join(source.root, 'scripts/test.ts'), '// changed selection semantics\n');
    await expect(
      nativeTestInventory(
        source.root,
        seal.files.map((entry) => entry.path)
      )
    ).rejects.toThrow('Unknown default test producer');
  });

  test('refuses source scripts that select cases or repeat attempts', async () => {
    const source = await checkout();
    const seal = await sealNativeSource(source.root);
    for (const selector of [
      '--test-name-pattern=selected',
      '-t selected',
      '-tselected',
      '--only',
      '--changed=main',
      '--shard=1/2',
      '--path-ignore-patterns=ignored',
      '--retry=2',
      '--rerun-each=2',
    ]) {
      const manifest = await Bun.file(join(source.root, 'package.json')).json();
      manifest.scripts['test:scripts'] = `bun test scripts ${selector}`;
      await file(join(source.root, 'package.json'), JSON.stringify(manifest));
      await expect(
        nativeTestInventory(
          source.root,
          seal.files.map((entry) => entry.path)
        )
      ).rejects.toThrow('expected an unfiltered single-attempt suite');
    }
  });
});

describe('full qualification receipts', () => {
  // One case per graph: a full fake run takes 3-5 s on Windows, so four in one test
  // outlast the lane's 15 s budget there.
  for (const target of ['runtime', 'fake'] as const) {
    for (const featureType of ['sdk', 'primary'] as const) {
      test(`rejects an altered ${target} ${featureType} feature graph before validation`, async () => {
        const source = await checkout();
        const fake = new FakeNativeCommands();
        if (featureType === 'sdk') fake.sdkFeatures[target] = ['different'];
        else fake.primaryFeatures[target] = ['different'];
        const receipt = await runNativeQualification(source, {
          runCommand: fake.run,
          snapshotProcesses: emptyNativeCensus,
        });
        expect(receipt.status).toBe('setup-failed');
        expect(receipt.setupErrors.join('\n')).toContain('features');
        expect(receipt.setupErrors.join('\n')).toContain('different');
        expect(fake.calls.some((call) => call.label === 'check' || call.label === 'test')).toBe(
          false
        );
      });
    }
  }

  test('passes a complete single-attempt run with immutable source/artifacts and explicit binaries', async () => {
    const source = await checkout();
    const fake = new FakeNativeCommands();
    const receipt = await runNativeQualification(source, {
      runCommand: fake.run,
      snapshotProcesses: emptyNativeCensus,
    });
    expect(receipt.status).toBe('qualified');
    expect(receipt.setupErrors).toEqual([]);
    expect(receipt.validationErrors).toEqual([]);
    expect(receipt.tests?.complete).toBe(true);
    expect(receipt.terminal.empty).toBe(true);
    expect(
      fake.calls
        .filter((call) => ['check', 'test'].includes(call.label))
        .map((call) => call.command)
    ).toEqual([
      ['bun', 'run', 'check'],
      ['bun', 'run', 'test'],
    ]);
    const targets = fake.calls
      .filter((call) => call.label.startsWith('build-'))
      .map((call) => call.env.CARGO_TARGET_DIR);
    expect(new Set(targets).size).toBe(2);
    const physicalTargets = join(await realpath(source.out), 'targets');
    expect(targets.every((target) => target?.startsWith(physicalTargets))).toBe(true);
    const testCall = fake.calls.find((call) => call.label === 'test');
    expect(fake.calls.find((call) => call.label === 'rustc-version')?.timeoutSeconds).toBe(180);
    expect(testCall?.env.MANGOSTUDIO_RUNTIME_BINARY).toBe(receipt.artifactsBefore[0].path);
    expect(testCall?.env.MANGOSTUDIO_FAKE_CURSOR_AGENT).toBe(receipt.artifactsBefore[1].path);
    expect(JSON.parse(await readFile(join(source.out, 'receipt.json'), 'utf8')).status).toBe(
      'qualified'
    );
    expect(
      (await collectNativeTestEvidence(source.root, source.out, receipt.tests?.inventory ?? []))
        .complete
    ).toBe(true);
  });

  test('runs test once after a failing check and retains the failing check receipt', async () => {
    const source = await checkout();
    const fake = new FakeNativeCommands();
    fake.checkExit = 1;
    const receipt = await runNativeQualification(source, {
      runCommand: fake.run,
      snapshotProcesses: emptyNativeCensus,
    });
    expect(receipt.status).toBe('validation-failed');
    expect(fake.calls.filter((call) => call.label === 'test')).toHaveLength(1);
    expect(receipt.tests?.complete).toBe(true);
    expect(receipt.validationErrors.join('\n')).toContain('check: exit 1');
  });

  test('requires an observed full-suite root while recording fast metadata scope honestly', async () => {
    const source = await checkout();
    const fake = new FakeNativeCommands();
    fake.unobservedLabel = 'check';
    const receipt = await runNativeQualification(source, {
      runCommand: fake.run,
      snapshotProcesses: emptyNativeCensus,
    });
    expect(receipt.status).toBe('validation-failed');
    expect(receipt.validationErrors.join('\n')).toContain('check: command root was never observed');
    expect(fake.calls.filter((call) => call.label === 'test')).toHaveLength(1);
    const metadataSource = await checkout();
    const metadata = new FakeNativeCommands();
    metadata.unobservedLabel = 'rustc-version';
    const qualified = await runNativeQualification(metadataSource, {
      runCommand: metadata.run,
      snapshotProcesses: emptyNativeCensus,
    });
    expect(qualified.status).toBe('qualified');
    expect(
      qualified.commands.find((command) => command.label === 'rustc-version')?.settlement
        .rootObserved
    ).toBe(false);
  });

  test('refuses misleading zero-exit receipts with skipped integration lanes', async () => {
    const source = await checkout();
    const fake = new FakeNativeCommands();
    fake.omitIntegration = true;
    const receipt = await runNativeQualification(source, {
      runCommand: fake.run,
      snapshotProcesses: emptyNativeCensus,
    });
    expect(receipt.commands.find((command) => command.label === 'test')?.exitCode).toBe(0);
    expect(receipt.status).toBe('validation-failed');
    expect(receipt.tests?.complete).toBe(false);
    expect(receipt.validationErrors.join('\n')).toContain(
      'api-integration: Missing 1 required files'
    );
  });

  test('retains setup failure separately and rejects mismatched source identity', async () => {
    const source = await checkout();
    const fake = new FakeNativeCommands();
    fake.installExit = 1;
    const receipt = await runNativeQualification(source, {
      runCommand: fake.run,
      snapshotProcesses: emptyNativeCensus,
    });
    expect(receipt.status).toBe('setup-failed');
    expect(receipt.setupErrors.join('\n')).toContain('install: exit 1');
    expect(fake.calls.some((call) => call.label === 'test')).toBe(false);
    expect(
      JSON.parse(await readFile(join(source.out, 'receipt.json'), 'utf8')).sourceAfter.head
    ).toBe(source.sha);
    const other = await checkout();
    const mismatch = await runNativeQualification(
      { ...other, sha: 'f'.repeat(40) },
      { runCommand: fake.run, snapshotProcesses: emptyNativeCensus }
    );
    expect(mismatch.status).toBe('setup-failed');
    expect(mismatch.setupErrors.join('\n')).toContain(`Source HEAD ${other.sha}; expected`);
  });

  test('rejects source and runtime changes after validation', async () => {
    const source = await checkout();
    const fake = new FakeNativeCommands();
    fake.mutateSource = true;
    fake.mutateArtifact = true;
    const receipt = await runNativeQualification(source, {
      runCommand: fake.run,
      snapshotProcesses: emptyNativeCensus,
    });
    expect(receipt.status).toBe('validation-failed');
    expect(receipt.validationErrors).toContain(
      'Source HEAD, tree, tracked bytes, or clean status changed during qualification'
    );
    expect(receipt.validationErrors).toContain(
      'Explicit runtime/fake-agent artifact bytes changed during qualification'
    );
  });
});
