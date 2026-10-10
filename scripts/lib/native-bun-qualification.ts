import { access, mkdir, readdir, readFile, realpath } from 'node:fs/promises';
import { arch, release, tmpdir, type } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type NativeMsvcInventory,
  parseNativeMsvcInventory,
} from './native-bun-qualification-msvc';

import {
  type NativeCommandOptions,
  type NativeCommandReceipt,
  type NativeProcess,
  runNativeCommand,
  scopeNativeProcesses,
  snapshotNativeProcesses,
  unattributedNativeCompilerHelpers,
} from './native-bun-qualification-process';
import {
  collectNativeTestEvidence,
  type NativeTestEvidence,
  type NativeTestLane,
  nativeTestInventory,
} from './native-bun-qualification-results';
import {
  type ArtifactSeal,
  type NativeCompilerArtifact,
  nativeCompilerArtifacts,
  nativeSourceChanged,
  type SourceSeal,
  sealNativeArtifact,
  sealNativeSource,
} from './native-bun-qualification-source';
import {
  type NativeWindowsJobContext,
  runNativeWindowsJob,
} from './native-bun-qualification-windows';

export interface NativeQualificationOptions {
  readonly root: string;
  readonly out: string;
  readonly sha?: string;
}

export interface NativeQualificationDependencies {
  readonly runCommand?: (options: NativeCommandOptions) => Promise<NativeCommandReceipt>;
  readonly snapshotProcesses?: () => Promise<readonly NativeProcess[]>;
}

export interface NativeQualificationReceipt {
  readonly schemaVersion: 1;
  readonly startedAt: string;
  finishedAt: string | null;
  readonly root: string;
  readonly out: string;
  readonly expectedSha: string | null;
  readonly host: {
    platform: string;
    arch: string;
    release: string;
    type: string;
    githubActions: boolean;
    runnerOS: string | null;
  };
  readonly commandPolicy: {
    attempts: 1;
    fullCommands: readonly string[];
    totalTimeoutSeconds: number;
    inheritedSelectorsCleared: boolean;
  };
  status: 'running' | 'setup-failed' | 'validation-failed' | 'qualified';
  setupErrors: string[];
  validationErrors: string[];
  commands: NativeCommandReceipt[];
  toolchain: Record<string, string>;
  sourceBefore: SourceSeal | null;
  sourceAfter: SourceSeal | null;
  toolingBefore: SourceSeal | null;
  toolingAfter: SourceSeal | null;
  windowsJob: {
    readonly helperPath: string;
    readonly helperSha256: string;
    readonly installedTools: NativeMsvcInventory;
  } | null;
  artifactsBefore: ArtifactSeal[];
  artifactsAfter: ArtifactSeal[];
  buildArtifacts: Record<string, readonly NativeCompilerArtifact[]>;
  tests: NativeTestEvidence | null;
  terminal: {
    empty: boolean;
    errors: readonly string[];
    survivors: readonly NativeProcess[];
    unattributedCompilerHelpers?: readonly NativeProcess[];
  };
}

const TOTAL_TIMEOUT_SECONDS = 55 * 60;

/** Parse a source checkout and a separate receipt directory. @example parseNativeQualificationArgs(['--root', '../source', '--out', '../receipts', '--sha', sha]); */
export function parseNativeQualificationArgs(args: readonly string[]): NativeQualificationOptions {
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    // Only the first `=` separates the flag: `split('=', 2)` drops the rest of a path holding one.
    const separator = arg.indexOf('=');
    const key = separator === -1 ? arg : arg.slice(0, separator);
    const inline = separator === -1 ? undefined : arg.slice(separator + 1);
    if (!['--root', '--out', '--sha'].includes(key) || values[key] !== undefined) {
      throw new Error(
        `Invalid argument ${JSON.stringify(arg)}; expected one --root, --out, or --sha`
      );
    }
    const value = inline ?? args[++index];
    if (!value || value.startsWith('--'))
      throw new Error(`Invalid ${key} value ${JSON.stringify(value)}; expected a path or SHA`);
    values[key] = value;
  }
  if (!values['--root'] || !values['--out'])
    throw new Error('Missing --root or --out; expected a source path and a separate receipt path');
  const sha = values['--sha'];
  if (sha && !/^[a-f0-9]{40}$/.test(sha))
    throw new Error(
      `Invalid --sha ${JSON.stringify(sha)}; expected a full 40-character lowercase commit SHA`
    );
  return {
    root: resolve(values['--root']),
    out: resolve(values['--out']),
    ...(sha ? { sha } : {}),
  };
}

/**
 * Clear inherited selection, remote-cache, host configuration, and Cargo override inputs.
 * Explicit runtime paths are added after the fresh default-feature builds succeed.
 * Turbo telemetry stays off: the `TURBO_` sweep would otherwise drop the caller's opt-out.
 * @example nativeQualificationEnvironment(process.env);
 */
export function nativeQualificationEnvironment(
  inherited: NodeJS.ProcessEnv
): Record<string, string | undefined> {
  const env = { ...inherited };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith('MANGOSTUDIO_') ||
      key.startsWith('TURBO_') ||
      key.startsWith('CARGO_BUILD_') ||
      key.startsWith('CARGO_PROFILE_') ||
      key.startsWith('CARGO_TARGET_') ||
      [
        'DATABASE_PATH',
        'MANGO_INTEROP',
        'MANGO_TEST_WORKERS',
        'BUN_OPTIONS',
        'CARGO_TARGET_DIR',
        'CARGO_BUILD_TARGET',
        'RUSTFLAGS',
        'RUSTDOCFLAGS',
        'CARGO_ENCODED_RUSTFLAGS',
      ].includes(key)
    )
      delete env[key];
  }
  return {
    ...env,
    CI: 'true',
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    TURBO_FORCE: 'true',
    TURBO_TELEMETRY_DISABLED: '1',
    MANGOSTUDIO_BUN_TEST_ARGS: '',
  };
}

function contained(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

async function requireFreshSource(root: string): Promise<void> {
  for (const path of [
    'node_modules',
    '.turbo',
    '.mango/artifacts',
    'apps/api/.turbo',
    'apps/shared/.turbo',
    'apps/frontend/.turbo',
    'packages/protocol/.turbo',
  ]) {
    try {
      await access(join(root, path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    throw new Error(
      `Existing source state ${path}; expected a fresh checkout without dependency/result caches`
    );
  }
}

function commandFailures(receipt: NativeCommandReceipt): string[] {
  const errors = [...receipt.errors];
  if (
    ['install', 'build-runtime', 'build-fake-agent', 'check', 'test'].includes(receipt.label) &&
    !receipt.settlement.rootObserved
  )
    errors.push('command root was never observed; expected positive ownership during execution');
  if (receipt.exitCode !== 0) errors.push(`exit ${receipt.exitCode}, signal ${receipt.signal}`);
  if (receipt.timedOut) errors.push(`timed out after ${receipt.timeoutSeconds}s`);
  if (!receipt.settlement.empty)
    errors.push(
      `terminal census not empty or unavailable: ${receipt.settlement.survivors.length} survivors, ${receipt.settlement.snapshotErrors.length} snapshot errors`
    );
  return errors.map((error) => `${receipt.label}: ${error}`);
}

async function writeReceipt(receipt: NativeQualificationReceipt): Promise<void> {
  await Bun.write(join(receipt.out, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
}

async function runSetup(
  receipt: NativeQualificationReceipt,
  env: Record<string, string | undefined>,
  run: (
    label: string,
    command: readonly string[],
    timeout: number,
    overrides?: Record<string, string>
  ) => Promise<NativeCommandReceipt>
): Promise<readonly string[]> {
  for (const [label, command] of [
    ['bun-revision', ['bun', '--revision']],
    ['rustc-version', ['rustc', '-vV']],
    ['cargo-version', ['cargo', '-V']],
    [
      'cargo-normal-tree',
      ['cargo', 'tree', '-p', 'mangostudio-runtime', '--edges', 'normal', '--locked'],
    ],
  ] as const) {
    // The first Rust invocation can install the checkout's pinned toolchain.
    const timeout = label === 'rustc-version' ? 180 : label === 'cargo-normal-tree' ? 120 : 30;
    const result = await run(label, command, timeout);
    receipt.setupErrors.push(...commandFailures(result));
    receipt.toolchain[label] = await readFile(join(receipt.out, result.log), 'utf8');
    if (receipt.setupErrors.length) return [];
  }
  const expectedBun = (await Bun.file(join(receipt.root, 'package.json')).json()).packageManager;
  if (
    typeof expectedBun !== 'string' ||
    !receipt.toolchain['bun-revision'].trim().startsWith(`${expectedBun.slice(4)}+`)
  ) {
    receipt.setupErrors.push(
      `Bun revision ${JSON.stringify(receipt.toolchain['bun-revision'].trim())}; expected ${expectedBun}`
    );
    return [];
  }
  let buildStarted: number | null = null;
  for (const [label, command, timeout, target] of [
    ['install', ['bun', 'install', '--frozen-lockfile'], 600, null],
    [
      'build-runtime',
      [
        'cargo',
        'build',
        '-p',
        'mangostudio-runtime',
        '--bin',
        'mangostudio-runtime',
        '--locked',
        '--message-format=json',
      ],
      720,
      'runtime',
    ],
    [
      'build-fake-agent',
      [
        'cargo',
        'build',
        '-p',
        'mangostudio-runtime',
        '--example',
        'fake_cursor_agent',
        '--locked',
        '--message-format=json',
      ],
      180,
      'fake',
    ],
  ] as const) {
    const overrides: Record<string, string> = target
      ? { CARGO_TARGET_DIR: join(receipt.out, 'targets', target) }
      : {};
    if (target && buildStarted === null) buildStarted = Date.now();
    const remainingBuildSeconds = 900 - (Date.now() - (buildStarted ?? Date.now())) / 1_000;
    if (target && remainingBuildSeconds <= 0)
      throw new Error(
        'Native builds exceeded 900 seconds; expected runtime and fake-agent setup within 15 minutes'
      );
    const commandTimeout = target === 'fake' ? remainingBuildSeconds : timeout;
    receipt.setupErrors.push(
      ...commandFailures(await run(label, command, commandTimeout, overrides))
    );
    if (receipt.setupErrors.length) return [];
    if (target) {
      const compiled = nativeCompilerArtifacts(
        await readFile(join(receipt.out, `logs/${label}.stdout.log`), 'utf8')
      );
      receipt.buildArtifacts[target] = compiled;
      const sdk = compiled.filter((artifact) =>
        artifact.packageId.includes('mango-external-agents')
      );
      const expectedFeatures = target === 'runtime' ? ['stdio'] : ['stdio', 'testing'];
      if (
        !sdk.length ||
        sdk.some(
          (artifact) =>
            JSON.stringify([...artifact.features].sort()) !== JSON.stringify(expectedFeatures)
        )
      ) {
        throw new Error(
          `Invalid ${target} SDK features ${JSON.stringify(sdk.map((artifact) => artifact.features))}; expected ${JSON.stringify(expectedFeatures)}`
        );
      }
      const name = target === 'runtime' ? 'mangostudio-runtime' : 'fake_cursor_agent';
      const kind = target === 'runtime' ? 'bin' : 'example';
      const primary = compiled.filter(
        (artifact) =>
          artifact.target === name && artifact.executable && artifact.kind.includes(kind)
      );
      if (!primary.length || primary.some((artifact) => artifact.features.length))
        throw new Error(
          `Invalid compiler executable ${name} features ${JSON.stringify(primary.map((artifact) => artifact.features))}; expected an actual ${kind} executable with default empty features`
        );
      await Bun.write(
        join(receipt.out, 'build-features.json'),
        `${JSON.stringify(receipt.buildArtifacts, null, 2)}\n`
      );
    }
  }
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const runtime = join(receipt.out, 'targets/runtime/debug', `mangostudio-runtime${suffix}`);
  const fake = join(receipt.out, 'targets/fake/debug/examples', `fake_cursor_agent${suffix}`);
  env.MANGOSTUDIO_RUNTIME_BINARY = runtime;
  env.MANGOSTUDIO_FAKE_CURSOR_AGENT = fake;
  env.CARGO_TARGET_DIR = join(receipt.out, 'targets/runtime');
  return [runtime, fake];
}

/**
 * Qualify an immutable fresh source checkout with full default check/test commands.
 * A failing check still runs test; setup/identity failures remain distinct and retain receipts.
 * @example await runNativeQualification({ root: '/source', out: '/receipts', sha });
 */
export async function runNativeQualification(
  options: NativeQualificationOptions,
  dependencies: NativeQualificationDependencies = {}
): Promise<NativeQualificationReceipt> {
  const started = Date.now();
  const root = await realpath(options.root).catch(() => resolve(options.root));
  let out = resolve(options.out);
  if (contained(root, out) || contained(out, root))
    throw new Error(
      `Overlapping paths ${root} and ${out}; expected separate source and receipt directories`
    );
  await mkdir(out, { recursive: true });
  out = await realpath(out);
  if (contained(root, out) || contained(out, root))
    throw new Error(
      `Overlapping physical paths ${root} and ${out}; expected separate checkout and receipts`
    );
  if ((await readdir(out)).length)
    throw new Error(`Nonempty output ${out}; expected a new receipt directory`);
  const receipt: NativeQualificationReceipt = {
    schemaVersion: 1,
    startedAt: new Date(started).toISOString(),
    finishedAt: null,
    root,
    out,
    expectedSha: options.sha ?? null,
    host: {
      platform: process.platform,
      arch: arch(),
      release: release(),
      type: type(),
      githubActions: process.env.GITHUB_ACTIONS === 'true',
      runnerOS: process.env.RUNNER_OS ?? null,
    },
    commandPolicy: {
      attempts: 1,
      fullCommands: ['bun run check', 'bun run test'],
      totalTimeoutSeconds: TOTAL_TIMEOUT_SECONDS,
      inheritedSelectorsCleared: true,
    },
    status: 'running',
    setupErrors: [],
    validationErrors: [],
    commands: [],
    toolchain: {},
    sourceBefore: null,
    sourceAfter: null,
    toolingBefore: null,
    toolingAfter: null,
    windowsJob: null,
    artifactsBefore: [],
    artifactsAfter: [],
    buildArtifacts: {},
    tests: null,
    terminal: { empty: false, errors: ['qualification has not completed'], survivors: [] },
  };
  await writeReceipt(receipt);
  const env = nativeQualificationEnvironment(process.env);
  let artifacts: readonly string[] = [];
  let inventory: NativeTestLane[] = [];
  let processesBefore: readonly NativeProcess[] = [];
  let windowsContext: NativeWindowsJobContext | null = null;
  const toolingRoot = fileURLToPath(new URL('../../', import.meta.url));
  const nativeRun = (command: NativeCommandOptions): Promise<NativeCommandReceipt> => {
    if (dependencies.runCommand) return dependencies.runCommand(command);
    if (process.platform !== 'win32') return runNativeCommand(command);
    if (!windowsContext)
      throw new Error('Missing Windows Job context; expected sealed native ownership tooling');
    return runNativeWindowsJob(command, windowsContext);
  };
  const run = async (
    label: string,
    command: readonly string[],
    timeout: number,
    overrides: Record<string, string> = {}
  ): Promise<NativeCommandReceipt> => {
    const remaining = TOTAL_TIMEOUT_SECONDS - (Date.now() - started) / 1_000;
    if (remaining <= 0)
      throw new Error(
        `Qualification exceeded ${TOTAL_TIMEOUT_SECONDS}s; expected completion below the workflow bound`
      );
    const result = await nativeRun({
      label,
      command,
      root,
      out,
      env: { ...env, ...overrides },
      timeoutSeconds: Math.min(timeout, remaining),
    });
    receipt.commands.push(result);
    await Bun.write(join(out, `command-${label}.json`), `${JSON.stringify(result, null, 2)}\n`);
    await writeReceipt(receipt);
    return result;
  };
  try {
    if (process.platform === 'win32') {
      processesBefore = await (dependencies.snapshotProcesses ?? snapshotNativeProcesses)();
      await Bun.write(
        join(out, 'processes-before-qualification.json'),
        `${JSON.stringify(processesBefore, null, 2)}\n`
      );
    }
    receipt.sourceBefore = await sealNativeSource(root);
    if (receipt.sourceBefore.status)
      throw new Error(
        `Dirty source ${JSON.stringify(receipt.sourceBefore.status)}; expected a clean checkout`
      );
    if (options.sha && receipt.sourceBefore.head !== options.sha)
      throw new Error(`Source HEAD ${receipt.sourceBefore.head}; expected ${options.sha}`);
    await requireFreshSource(root);
    if (process.platform === 'win32' && !dependencies.runCommand) {
      receipt.toolingBefore = await sealNativeSource(toolingRoot);
      if (receipt.toolingBefore.status)
        throw new Error(
          `Dirty tooling ${JSON.stringify(receipt.toolingBefore.status)}; expected immutable qualification tooling`
        );
      const helperPath = join(toolingRoot, 'scripts/lib/native-windows-job.ps1');
      const helper = await sealNativeArtifact(helperPath);
      const sealedHelper = receipt.toolingBefore.files.find(
        (file) => file.path === 'scripts/lib/native-windows-job.ps1'
      );
      if (!sealedHelper || sealedHelper.sha256 !== helper.sha256)
        throw new Error(
          `Unsealed Windows helper ${helperPath}; expected tracked bytes matching tooling identity`
        );
      windowsContext = {
        helperPath,
        helperSha256: helper.sha256,
        sourceSha: receipt.sourceBefore.head,
        toolingSha: receipt.toolingBefore.head,
        privateDirectory: await realpath(tmpdir()),
        expectedVctip: [],
      };
      const shell = Bun.which('pwsh.exe') ?? Bun.which('powershell.exe');
      if (!shell) throw new Error('Missing PowerShell; expected a native Windows Job launcher');
      const inventoryPath = join(out, 'installed-msvc-tools.json');
      const attestation = await run(
        'msvc-inventory',
        [
          shell,
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-File',
          helperPath,
          '-AttestationPath',
          inventoryPath,
        ],
        60
      );
      const failures = commandFailures(attestation);
      if (failures.length) throw new Error(failures.join('\n'));
      const installedTools = parseNativeMsvcInventory(await readFile(inventoryPath, 'utf8'));
      windowsContext = { ...windowsContext, expectedVctip: installedTools.vctip };
      receipt.windowsJob = { helperPath, helperSha256: helper.sha256, installedTools };
      await writeReceipt(receipt);
    }
    inventory = await nativeTestInventory(
      root,
      receipt.sourceBefore.files.map((file) => file.path)
    );
    await Bun.write(join(out, 'inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`);
    artifacts = await runSetup(receipt, env, run);
    if (!receipt.setupErrors.length)
      receipt.artifactsBefore = await Promise.all(artifacts.map(sealNativeArtifact));
  } catch (error) {
    receipt.setupErrors.push(String(error));
  }
  if (!receipt.setupErrors.length) {
    try {
      receipt.validationErrors.push(
        ...commandFailures(await run('check', ['bun', 'run', 'check'], 600))
      );
    } catch (error) {
      receipt.validationErrors.push(`check: ${String(error)}`);
    }
    try {
      receipt.validationErrors.push(
        ...commandFailures(await run('test', ['bun', 'run', 'test'], 900))
      );
    } catch (error) {
      receipt.validationErrors.push(`test: ${String(error)}`);
    }
    try {
      receipt.tests = await collectNativeTestEvidence(root, out, inventory);
      receipt.validationErrors.push(...receipt.tests.errors);
    } catch (error) {
      receipt.validationErrors.push(`Test evidence collection: ${String(error)}`);
    }
  }
  try {
    receipt.sourceAfter = await sealNativeSource(root);
    if (
      receipt.sourceBefore &&
      (nativeSourceChanged(receipt.sourceBefore, receipt.sourceAfter) || receipt.sourceAfter.status)
    )
      receipt.validationErrors.push(
        'Source HEAD, tree, tracked bytes, or clean status changed during qualification'
      );
    if (receipt.toolingBefore) {
      receipt.toolingAfter = await sealNativeSource(toolingRoot);
      if (
        nativeSourceChanged(receipt.toolingBefore, receipt.toolingAfter) ||
        receipt.toolingAfter.status
      )
        receipt.validationErrors.push('Qualification tooling identity or tracked bytes changed');
    }
    receipt.artifactsAfter = await Promise.all(artifacts.map(sealNativeArtifact));
    if (JSON.stringify(receipt.artifactsBefore) !== JSON.stringify(receipt.artifactsAfter))
      receipt.validationErrors.push(
        'Explicit runtime/fake-agent artifact bytes changed during qualification'
      );
  } catch (error) {
    receipt.validationErrors.push(`Final identity evidence: ${String(error)}`);
  }
  const terminalErrors = receipt.commands.flatMap((command) =>
    command.settlement.empty
      ? []
      : [`${command.label}: terminal census failed`, ...command.settlement.snapshotErrors]
  );
  let survivors: NativeProcess[] = [];
  let unattributedCompilerHelpers: NativeProcess[] = [];
  try {
    const observed = receipt.commands.flatMap((command) => command.settlement.observed);
    const snapshot = await (dependencies.snapshotProcesses ?? snapshotNativeProcesses)();
    if (process.platform === 'win32') {
      await Bun.write(
        join(out, 'processes-after-qualification.json'),
        `${JSON.stringify(snapshot, null, 2)}\n`
      );
      unattributedCompilerHelpers = unattributedNativeCompilerHelpers(
        processesBefore,
        snapshot,
        observed
      );
      if (unattributedCompilerHelpers.length)
        terminalErrors.push(
          `Unattributed compiler helpers ${JSON.stringify(unattributedCompilerHelpers)}; expected verified ownership and an empty terminal census`
        );
    }
    survivors = scopeNativeProcesses(snapshot, {
      rootPid: -1,
      rootAlive: false,
      rootIdentity: null,
      observed,
    }).current;
    if (survivors.length)
      terminalErrors.push(`${survivors.length} owned processes remain in the final native census`);
  } catch (error) {
    terminalErrors.push(`Final native process snapshot failed: ${String(error)}`);
  }
  receipt.terminal = {
    empty: receipt.commands.length > 0 && terminalErrors.length === 0,
    errors: terminalErrors,
    survivors,
    ...(process.platform === 'win32' ? { unattributedCompilerHelpers } : {}),
  };
  receipt.validationErrors.push(...terminalErrors);
  receipt.finishedAt = new Date().toISOString();
  receipt.status = receipt.setupErrors.length
    ? 'setup-failed'
    : receipt.validationErrors.length
      ? 'validation-failed'
      : 'qualified';
  await Promise.all([
    Bun.write(
      join(out, 'source-seals.json'),
      `${JSON.stringify({ before: receipt.sourceBefore, after: receipt.sourceAfter }, null, 2)}\n`
    ),
    Bun.write(
      join(out, 'artifact-seals.json'),
      `${JSON.stringify({ before: receipt.artifactsBefore, after: receipt.artifactsAfter }, null, 2)}\n`
    ),
    Bun.write(join(out, 'terminal.json'), `${JSON.stringify(receipt.terminal, null, 2)}\n`),
  ]);
  await writeReceipt(receipt);
  return receipt;
}
