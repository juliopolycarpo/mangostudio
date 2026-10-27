import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, relative, resolve } from 'node:path';

import {
  findProtectedFile,
  runProtectGeneratedHook,
} from '../../.claude/hooks/protect-generated.mjs';
import {
  createPathExportLine,
  resolveRepoBin,
  updateClaudeEnvPath,
} from '../../.claude/hooks/session-path.mjs';
import {
  candidatePaths,
  chooseFormatter,
  extractTouchedFilePath,
  isInsideRepo,
  runAutoFixHook,
  shouldSkipFile,
} from '../../.codex/hooks/auto-fix.mjs';
import { publishFixtureJson } from './support/atomic-fixture-json';
import { fixtureChildEnvironment } from './support/child-supervision';
import { FormatterClock, HangingFormatter } from './support/fake-formatter-deadline';
import {
  CONTROL_ENV,
  formatterControlPath,
  GRANDCHILD_ENV,
  grandchildMarker,
  HANG_ENV,
  HEARTBEAT_MS,
  heartbeatPath,
  MARKER_ENV,
  QUIET_ENV,
  stopPath,
} from './support/fake-rustfmt-markers';
import { FORMATTER_CANCEL_CONTROL } from './support/formatter-cancel-control';
import { requestFormatterStop, withFormatterHookCleanup } from './support/formatter-hook-cleanup';
import {
  type OwnedFormatterProcess,
  readNativeFormatterProcess,
  waitForFormatterSettlement,
} from './support/formatter-process-settlement';

const repoRoot = join(import.meta.dir, '..', '..');
const tempDirs: string[] = [];
const hookEntrypoints = [
  ['Codex', join(repoRoot, '.codex', 'hooks', 'auto-fix.mjs')],
  ['Claude', join(repoRoot, '.claude', 'hooks', 'auto-fix.mjs')],
] as const;
// A rustup proxy on PATH does not mean the pinned formatter is installed.
const installedRustfmt = Bun.which('rustup')
  ? Bun.spawnSync(['rustup', 'which', 'rustfmt'], {
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: 5000,
    }).exitCode === 0
  : Boolean(Bun.which('rustfmt'));

async function makeTempDir() {
  const path = await mkdtemp(join(tmpdir(), 'mango-agent-hooks-'));
  tempDirs.push(path);
  return path;
}

/** Reads a fake's marker, naming the fake that never started instead of a bare ENOENT. */
async function readMarker(marker: string, who: string) {
  const text = await readFile(marker, 'utf8').catch(() => {
    throw new Error(`${who} never started | expected: a marker at ${marker} | received: none`);
  });
  return JSON.parse(text) as { args: string[]; cwd: string; pid: number; startedAt: number };
}

/**
 * Observe publication changes, not native liveness: silence can hide a live process and
 * one final publication may become visible after exit. POSIX verdicts use native identities.
 */
async function stillBeating(marker: string, afterBaseline?: () => void | Promise<void>) {
  const read = () => readFile(heartbeatPath(marker), 'utf8').catch(() => '');
  const before = await read();
  if (afterBaseline) await afterBaseline();
  await Bun.sleep(HEARTBEAT_MS * 6);
  return (await read()) !== before;
}

/**
 * Waits for the fake behind `marker` to beat once, naming it if it never does.
 *
 * @example
 * await firstHeartbeat(marker, 'fake rustfmt');
 */
async function firstHeartbeat(marker: string, who: string, timeoutMs = 5000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await Bun.file(heartbeatPath(marker)).exists()) return;
    await Bun.sleep(HEARTBEAT_MS);
  }
  throw new Error(
    `${who} never beat | expected: ${heartbeatPath(marker)} within ${timeoutMs}ms | received: none`
  );
}

/** Return an explicit owned-hook exit if a required control event never arrives. */
async function fixtureEvent(
  path: string,
  hook: Pick<ReturnType<typeof Bun.spawn>, 'exited'>
): Promise<boolean> {
  let exited = false;
  void hook.exited.then(() => {
    exited = true;
  });
  const deadline = performance.now() + 5000;
  while (!(await Bun.file(path).exists())) {
    if (exited) return false;
    if (performance.now() >= deadline)
      throw new Error(`expected fixture event ${path} within 5000ms`);
    await Bun.sleep(10);
  }
  return true;
}

/** Bind native births while the hook and its two controlled descendants are still live. */
async function captureOwnedFormatters(
  hook: Pick<ReturnType<typeof Bun.spawn>, 'pid' | 'exitCode' | 'signalCode'>,
  fakes: readonly (readonly [marker: string, who: string])[],
  ownGroup = false
): Promise<OwnedFormatterProcess[]> {
  for (const [marker, who] of fakes) await firstHeartbeat(marker, who);
  expect(hook.exitCode, 'expected a live owned hook before cancellation/deadline').toBeNull();
  expect(hook.signalCode).toBeNull();
  const hookNative = await readNativeFormatterProcess(hook.pid);
  expect(hookNative).toBeDefined();
  expect(hookNative?.state).not.toBe('Z');
  if (ownGroup) expect(hookNative?.group).toBe(hook.pid);
  const owned: OwnedFormatterProcess[] = [];
  for (const [marker, who] of fakes) {
    const started = await readMarker(marker, who);
    const native = await readNativeFormatterProcess(started.pid);
    if (!native)
      throw new Error(`${who}: expected a live native birth identity | received: absent`);
    expect(native.state).not.toBe('Z');
    owned.push({ who, native });
  }
  expect(owned[0]?.native.parentPid).toBe(hook.pid);
  expect(owned[0]?.native.group).toBe(owned[0]?.native.pid);
  expect(owned[1]?.native.parentPid).toBe(owned[0]?.native.pid);
  expect(owned[1]?.native.group).toBe(owned[0]?.native.group);
  return owned;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('agent auto-fix hooks', () => {
  let fakeRustfmtBin = '';

  beforeAll(async () => {
    // A native executable exercises the hook's real PATH lookup on Windows too.
    fakeRustfmtBin = await mkdtemp(join(tmpdir(), 'mango-fake-rustfmt-'));
    const result = await Bun.build({
      entrypoints: [join(import.meta.dir, 'support', 'fake-rustfmt.ts')],
      compile: {
        outfile: join(fakeRustfmtBin, process.platform === 'win32' ? 'rustfmt.exe' : 'rustfmt'),
        // The fake runs in the repo root; its bunfig.toml and .env are not the fake's.
        autoloadDotenv: false,
        autoloadBunfig: false,
      },
    });
    expect(result.success, result.logs.map(String).join('\n')).toBe(true);
  }, 30_000);

  afterAll(async () => {
    if (fakeRustfmtBin) await rm(fakeRustfmtBin, { recursive: true, force: true });
  });

  /**
   * Put the named formatter first on one PATH entry, including Windows hosts
   * whose inherited environment spells the key `Path`.
   * @example
   * formatterEnvironment(marker, '1'); // hanging formatter and grandchild
   */
  const formatterEnvironment = (
    marker: string,
    hang = '0',
    ambient: NodeJS.ProcessEnv = process.env
  ): NodeJS.ProcessEnv => {
    const environment = fixtureChildEnvironment(ambient);
    const path =
      ambient.PATH ??
      Object.entries(ambient).find(([key]) => key.toLowerCase() === 'path')?.[1] ??
      '';
    for (const key of Object.keys(environment)) {
      if (key.toLowerCase() === 'path') delete environment[key];
    }
    return {
      ...environment,
      PATH: `${fakeRustfmtBin}${delimiter}${path}`,
      [MARKER_ENV]: marker,
      [HANG_ENV]: hang,
      [GRANDCHILD_ENV]: '0',
      [QUIET_ENV]: '0',
      [CONTROL_ENV]: '',
    };
  };

  it('gives the fake formatter one PATH when Windows inherits Path', () => {
    const environment = formatterEnvironment('marker', '0', { Path: 'inherited-path' });
    expect(environment.Path).toBeUndefined();
    expect(environment.PATH).toBe(`${fakeRustfmtBin}${delimiter}inherited-path`);
    expect(Object.keys(environment).filter((key) => key.toLowerCase() === 'path')).toEqual([
      'PATH',
    ]);
  });

  it('extracts touched files from Claude and Codex hook payloads', () => {
    const claudeInput = JSON.stringify({ tool_input: { file_path: 'apps/api/src/app.ts' } });
    const codexInput = JSON.stringify({ path: 'README.md' });

    expect(extractTouchedFilePath(claudeInput)).toBe('apps/api/src/app.ts');
    expect(extractTouchedFilePath(codexInput)).toBe('README.md');
    expect(extractTouchedFilePath('not json')).toBe('');
  });

  it('keeps formatting scoped to files inside the repo', () => {
    const root = join('workspace', 'mangostudio');

    expect(isInsideRepo(join(root, 'README.md'), root)).toBe(true);
    expect(isInsideRepo(join('workspace', 'other', 'README.md'), root)).toBe(false);
  });

  it('skips generated and dependency files', () => {
    expect(shouldSkipFile(join('repo', 'node_modules', 'pkg', 'index.ts'))).toBe(true);
    expect(shouldSkipFile(join('repo', 'apps', 'frontend', 'src', 'routeTree.gen.ts'))).toBe(true);
    expect(shouldSkipFile(join('repo', 'apps', 'api', 'src', 'app.ts'))).toBe(false);
  });

  it('chooses the formatter from the touched file name', () => {
    expect(chooseFormatter('src/app.ts')).toBe('bun');
    expect(chooseFormatter('src/app.json')).toBe('fmt');
    expect(chooseFormatter('docs/README.md')).toBe('fmt');
    expect(chooseFormatter('docs/README.mdc')).toBe('fmt');
    expect(chooseFormatter('Dockerfile.release')).toBeUndefined();
    expect(chooseFormatter('crates/mango-protocol/src/lib.rs')).toBe('rustfmt');
    expect(chooseFormatter('assets/logo.png')).toBeUndefined();
  });

  it.skipIf(!installedRustfmt)('formats a touched Rust file with rustfmt', async () => {
    const dir = join(repoRoot, '.mango', `agent-hooks-${process.pid}-${Date.now()}`);
    tempDirs.push(dir);
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, 'sample.rs');
    await writeFile(filePath, 'fn  main( ){let x=1;}\n', 'utf8');

    await runAutoFixHook(JSON.stringify({ tool_input: { file_path: filePath } }));

    expect(await readFile(filePath, 'utf8')).toBe('fn main() {\n    let x = 1;\n}\n');
  });

  it('starts the five-second formatter deadline after cold hook startup', async () => {
    const dir = join(repoRoot, '.mango', `formatter-clock-${process.pid}`);
    tempDirs.push(dir);
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, 'sample.rs');
    await writeFile(filePath, 'fn main() {}\n');
    const clock = new FormatterClock();
    const formatter = new HangingFormatter(clock);
    const spawn = spyOn(Bun, 'spawn').mockImplementation(formatter.spawn as typeof Bun.spawn);
    const spawnSync = spyOn(Bun, 'spawnSync').mockImplementation(
      formatter.taskkill as typeof Bun.spawnSync
    );
    const signal = spyOn(process, 'kill').mockImplementation(formatter.signal);
    const schedule = spyOn(globalThis, 'setTimeout').mockImplementation(
      clock.schedule as typeof setTimeout
    );
    const cancel = spyOn(globalThis, 'clearTimeout').mockImplementation(
      clock.cancel as typeof clearTimeout
    );
    const running = runAutoFixHook(JSON.stringify({ path: filePath }));
    try {
      await formatter.started;
      expect(formatter.startedAt).toBe(6_000);
      clock.advance(4_999);
      expect(
        formatter.killedAt,
        'formatter must remain alive until its own five-second deadline'
      ).toEqual([]);
      clock.advance(1);
      expect(formatter.killedAt).toEqual([11_000]);
      expect(formatter.treeStops).toEqual([process.platform === 'win32' ? 'taskkill' : 'group']);
      await running;
    } finally {
      formatter.release();
      try {
        await running;
      } finally {
        cancel.mockRestore();
        schedule.mockRestore();
        signal.mockRestore();
        spawnSync.mockRestore();
        spawn.mockRestore();
      }
    }
  });

  it('bounds a formatter that never exits, grandchildren included', async () => {
    const dir = await makeTempDir();
    const marker = join(dir, 'started.json');
    const filePath = join(repoRoot, '.mango', `formatter-timeout-${process.pid}.rs`);
    tempDirs.push(filePath);
    await writeFile(filePath, 'fn main() {}\n');
    const proc = Bun.spawn([process.execPath, hookEntrypoints[0][1]], {
      env: formatterEnvironment(marker, '1'),
      stdin: 'pipe',
      stdout: 'ignore',
      stderr: 'pipe',
      // Allow hook startup and Windows tree termination around the 5-second formatter deadline.
      timeout: 15_000,
    });
    const fakes = [
      [marker, 'fake rustfmt'],
      [grandchildMarker(marker), 'the grandchild of fake rustfmt'],
    ] as const;
    const leaked: number[] = [];
    await withFormatterHookCleanup(
      proc,
      fakes,
      async () => {
        await proc.stdin.write(JSON.stringify({ path: filePath }));
        await proc.stdin.end();
        const nativeOwned =
          process.platform === 'win32' ? undefined : await captureOwnedFormatters(proc, fakes);
        const exitCode = await proc.exited;
        expect(exitCode).toBe(0);
        expect(proc.signalCode).toBeNull();
        if (nativeOwned) await waitForFormatterSettlement(nativeOwned);
        for (const [fakeMarker, who] of fakes) {
          const started = await readMarker(fakeMarker, who);
          expect(started.args).toEqual([filePath]);
          expect(started.cwd).toBe(repoRoot);
          if (!nativeOwned && (await stillBeating(fakeMarker))) leaked.push(started.pid);
          const lastBeat = JSON.parse(await readFile(heartbeatPath(fakeMarker), 'utf8')) as {
            at: number;
          };
          // Measure the formatter's live interval, excluding cold hook startup. A longer
          // formatter deadline still fails this bound; both descendants must also stop.
          expect(
            lastBeat.at - started.startedAt,
            `${who}: expected less than 7000ms alive`
          ).toBeLessThan(7000);
        }
        expect(leaked).toEqual([]);
        expect(await readFile(filePath, 'utf8')).toBe('fn main() {}\n');
      },
      { requestStop: requestFormatterStop, stillBeating }
    );
  }, 20_000);

  // Keep the existing POSIX coverage; Windows has no hook group signal to forward.
  it
    .skipIf(process.platform === 'win32')
    .each(['normal', 'spawn-gap', 'exit-settlement', 'deadline-first'] as const)(
    'settles the native formatter tree on cancellation: %s',
    async (mode) => {
      const dir = await makeTempDir();
      const marker = join(dir, 'started.json');
      const filePath = join(repoRoot, '.mango', `formatter-cancel-${mode}-${process.pid}.rs`);
      tempDirs.push(filePath);
      await writeFile(filePath, 'fn main() {}\n');
      const command =
        mode === 'normal'
          ? [process.execPath]
          : [process.execPath, '--preload', FORMATTER_CANCEL_CONTROL];
      const proc = Bun.spawn([...command, hookEntrypoints[0][1]], {
        env: { ...formatterEnvironment(marker, '1'), [CONTROL_ENV]: mode === 'normal' ? '' : mode },
        detached: true,
        stdin: 'pipe',
        stdout: 'ignore',
        stderr: 'ignore',
        timeout: 8000,
      });
      const fakes = [
        [marker, 'fake rustfmt'],
        [grandchildMarker(marker), 'the grandchild of fake rustfmt'],
      ] as const;
      await withFormatterHookCleanup(
        proc,
        fakes,
        async () => {
          try {
            await proc.stdin.write(JSON.stringify({ path: filePath }));
            await proc.stdin.end();
            const owned = await captureOwnedFormatters(proc, fakes, true);
            if (mode === 'deadline-first') {
              await writeFile(formatterControlPath(marker, 'fire-deadline'), '');
            } else {
              // This is the retained, still-live hook's group, not a marker PID.
              process.kill(-proc.pid, mode === 'exit-settlement' ? 'SIGINT' : 'SIGTERM');
            }
            if (mode === 'spawn-gap') {
              await Bun.sleep(HEARTBEAT_MS);
              await writeFile(formatterControlPath(marker, 'spawn-release'), '');
            }
            if (mode === 'exit-settlement' || mode === 'deadline-first') {
              const observed = await fixtureEvent(
                formatterControlPath(marker, 'exit-observed'),
                proc
              );
              expect(
                observed,
                'expected owned formatter exit receipt before hook cancellation exit'
              ).toBe(true);
              expect(
                proc.exitCode,
                'hook must retain its pending formatter exit promise'
              ).toBeNull();
              expect(proc.signalCode).toBeNull();
              const receipt = JSON.parse(
                await readFile(formatterControlPath(marker, 'exit-observed'), 'utf8')
              );
              expect(receipt.groupStops).toBe(1);
              expect(receipt.handleStops).toBe(1);
              expect(receipt.timers).toBe(0);
              expect(receipt.listeners).toEqual({ SIGINT: 1, SIGTERM: 1, SIGHUP: 1 });
              await writeFile(formatterControlPath(marker, 'exit-release'), '');
            }
            const exit = await proc.exited;
            await waitForFormatterSettlement(owned);
            expect(exit).toBe(mode === 'normal' || mode === 'spawn-gap' ? 143 : 130);
            expect(proc.exitCode).toBe(exit);
          } finally {
            await Promise.all(
              ['spawn-release', 'exit-release'].map((event) =>
                writeFile(formatterControlPath(marker, event), '')
              )
            );
          }
        },
        { requestStop: requestFormatterStop, stillBeating }
      );
    },
    10000
  );

  it.skipIf(process.platform === 'win32').each(['signal-before-return', 'spawn-throw'] as const)(
    'settles formatter transfer or spawn refusal: %s',
    async (mode) => {
      const dir = await makeTempDir();
      const marker = join(dir, 'started.json');
      const filePath = join(repoRoot, '.mango', `formatter-transfer-${mode}-${process.pid}.rs`);
      tempDirs.push(filePath);
      await writeFile(filePath, 'fn main() {}\n');
      const proc = Bun.spawn(
        [process.execPath, '--preload', FORMATTER_CANCEL_CONTROL, hookEntrypoints[0][1]],
        {
          env: { ...formatterEnvironment(marker, '1'), [CONTROL_ENV]: mode },
          stdin: 'pipe',
          stdout: 'ignore',
          stderr: 'ignore',
          timeout: 8000,
        }
      );
      const fakes = [
        [marker, 'formatter'],
        [grandchildMarker(marker), 'grandchild'],
      ] as const;
      await withFormatterHookCleanup(
        proc,
        fakes,
        async () => {
          await proc.stdin.write(JSON.stringify({ path: filePath }));
          await proc.stdin.end();
          expect(await proc.exited).toBe(mode === 'spawn-throw' ? 0 : 130);
          const receipt = JSON.parse(
            await readFile(formatterControlPath(marker, 'control-exit'), 'utf8')
          );
          expect(receipt.listeners).toEqual({ SIGINT: 0, SIGTERM: 0, SIGHUP: 0 });
          expect(receipt.timers).toBe(0);
          expect(receipt.groupStops).toBe(mode === 'spawn-throw' ? 0 : 1);
          if (mode === 'signal-before-return') expect(receipt.nativeSettled).toBe(true);
        },
        { requestStop: requestFormatterStop, stillBeating }
      );
    },
    10000
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a quiet live formatter without relying on heartbeat changes',
    async () => {
      const dir = await makeTempDir();
      const marker = join(dir, 'quiet.json');
      const proc = Bun.spawn([join(fakeRustfmtBin, 'rustfmt')], {
        env: { ...formatterEnvironment(marker, '1'), [GRANDCHILD_ENV]: '1', [QUIET_ENV]: '1' },
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
        timeout: 8000,
      });
      await withFormatterHookCleanup(
        proc,
        [[marker, 'quiet formatter']],
        async () => {
          expect(await fixtureEvent(marker, proc)).toBe(true);
          const native = await readNativeFormatterProcess(proc.pid);
          if (!native)
            throw new Error(
              'formatter fixture: expected a live native identity | received: absent'
            );
          expect(native.state).not.toBe('Z');
          expect(await Bun.file(heartbeatPath(marker)).exists()).toBe(false);
          await expect(
            waitForFormatterSettlement([{ who: 'quiet formatter', native }])
          ).rejects.toThrow('expected live owned processes: 0');
          await requestFormatterStop(marker);
          expect(await proc.exited).toBe(0);
        },
        { requestStop: requestFormatterStop, stillBeating }
      );
    },
    10000
  );

  it.skipIf(process.platform === 'win32')(
    'accepts native exit despite a final heartbeat publication becoming visible',
    async () => {
      const dir = await makeTempDir();
      const marker = join(dir, 'final.json');
      const proc = Bun.spawn([join(fakeRustfmtBin, 'rustfmt')], {
        env: { ...formatterEnvironment(marker, '1'), [GRANDCHILD_ENV]: '1' },
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
        timeout: 8000,
      });
      await withFormatterHookCleanup(
        proc,
        [[marker, 'final formatter']],
        async () => {
          await firstHeartbeat(marker, 'final formatter');
          const native = await readNativeFormatterProcess(proc.pid);
          if (!native)
            throw new Error(
              'formatter fixture: expected a live native identity | received: absent'
            );
          expect(native.state).not.toBe('Z');
          await requestFormatterStop(marker);
          expect(await proc.exited).toBe(0);
          await waitForFormatterSettlement([{ who: 'final formatter', native }]);
          const previous = JSON.parse(await readFile(heartbeatPath(marker), 'utf8')) as {
            beat: number;
            at: number;
          };
          function publishFinalHeartbeat(): void {
            publishFixtureJson(heartbeatPath(marker), {
              beat: previous.beat + 1,
              at: previous.at + HEARTBEAT_MS,
            });
          }
          expect(await stillBeating(marker, publishFinalHeartbeat)).toBe(true);
          await waitForFormatterSettlement([{ who: 'final formatter', native }]);
        },
        { requestStop: requestFormatterStop, stillBeating }
      );
    },
    10000
  );

  it.each(['running tree', 'late grandchild'] as const)(
    'cooperatively stops a %s',
    async (state) => {
      const dir = await makeTempDir();
      const marker = join(dir, 'started.json');
      const fakes = [
        [marker, 'fake rustfmt'],
        [grandchildMarker(marker), 'the grandchild of fake rustfmt'],
      ] as const;
      if (state === 'late grandchild') {
        await Promise.all(fakes.map(([fakeMarker]) => requestFormatterStop(fakeMarker)));
      }
      const executable = join(
        fakeRustfmtBin,
        process.platform === 'win32' ? 'rustfmt.exe' : 'rustfmt'
      );
      const launchMarker = state === 'late grandchild' ? grandchildMarker(marker) : marker;
      const proc = Bun.spawn([executable], {
        env: {
          ...formatterEnvironment(launchMarker, '1'),
          [GRANDCHILD_ENV]: state === 'late grandchild' ? '1' : '0',
        },
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
        timeout: 8000,
      });
      await withFormatterHookCleanup(
        proc,
        fakes,
        async () => {
          if (state === 'running tree') {
            for (const [fakeMarker, who] of fakes) await firstHeartbeat(fakeMarker, who);
            for (const [fakeMarker] of fakes) expect(await stillBeating(fakeMarker)).toBe(true);
            await Promise.all(fakes.map(([fakeMarker]) => requestFormatterStop(fakeMarker)));
          }
          expect(await proc.exited).toBe(0);
          expect(proc.signalCode).toBeNull();
          for (const [fakeMarker] of fakes) {
            expect(await Bun.file(stopPath(fakeMarker)).exists()).toBe(true);
            expect(await stillBeating(fakeMarker)).toBe(false);
            if (state === 'late grandchild') {
              expect(await Bun.file(fakeMarker).exists()).toBe(false);
              expect(await Bun.file(heartbeatPath(fakeMarker)).exists()).toBe(false);
            }
          }
        },
        { requestStop: requestFormatterStop, stillBeating }
      );
    },
    10000
  );

  it('lists cwd-relative paths before repo-root ones only for a cwd inside the repo', () => {
    const root = resolve('/workspace', 'mangostudio');
    const outside = resolve('/workspace', 'other');
    const nested = join(root, 'crates', 'foo');

    expect(candidatePaths('src/lib.rs', nested, root)).toEqual([
      join(nested, 'src', 'lib.rs'),
      join(root, 'src', 'lib.rs'),
    ]);
    expect(candidatePaths('src/lib.rs', root, root)).toEqual([join(root, 'src', 'lib.rs')]);
    expect(candidatePaths('lib.rs', outside, root)).toEqual([join(outside, 'lib.rs')]);
    expect(candidatePaths(join(nested, 'lib.rs'), root, root)).toEqual([join(nested, 'lib.rs')]);
    expect(candidatePaths('', root, root)).toEqual([]);
  });

  it.each(
    hookEntrypoints.flatMap(([agent, entrypoint]) => [
      [agent, 'cwd-relative', entrypoint, () => 'sample.rs'] as const,
      [
        agent,
        'repo-relative',
        entrypoint,
        (dir: string) => relative(repoRoot, join(dir, 'sample.rs')),
      ] as const,
    ])
  )(
    'the %s hook formats a %s touched file from a nested cwd',
    async (_agent, _kind, entrypoint, touchedPath) => {
      const bin = await makeTempDir();
      const marker = join(bin, 'formatted');
      const dir = join(repoRoot, '.mango', `agent-hooks-cwd-${process.pid}-${Date.now()}`);
      tempDirs.push(dir);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'sample.rs'), 'fn main() {}\n');
      const proc = Bun.spawn([process.execPath, entrypoint], {
        env: formatterEnvironment(marker),
        stdin: 'pipe',
        stdout: 'ignore',
        stderr: 'ignore',
        timeout: 8000,
      });
      await proc.stdin.write(JSON.stringify({ cwd: dir, path: touchedPath(dir) }));
      await proc.stdin.end();

      expect(await proc.exited).toBe(0);
      const recorded = await readMarker(marker, 'fake rustfmt');
      expect(recorded.args).toEqual([join(dir, 'sample.rs')]);
      expect(recorded.cwd).toBe(repoRoot);
    },
    10000
  );

  it('ignores missing touched files without failing the hook', async () => {
    await expect(
      runAutoFixHook(JSON.stringify({ path: 'missing-file.ts' }))
    ).resolves.toBeUndefined();
  });
});

describe('Claude session path hook', () => {
  it('creates a shell export that prepends the repo bin path', () => {
    expect(createPathExportLine('/repo/node_modules/.bin', ':')).toBe(
      'export PATH=\'/repo/node_modules/.bin:\'"$PATH"\n'
    );
  });

  it('resolves the repo-local binary directory', () => {
    expect(resolveRepoBin('/repo')).toBe(join('/repo', 'node_modules', '.bin'));
    expect(resolveRepoBin('')).toBe('');
  });

  it('writes the Claude env file when the repo bin exists', async () => {
    const projectDir = await makeTempDir();
    const envFile = join(projectDir, 'claude-env');
    const repoBin = resolveRepoBin(projectDir);
    await mkdir(repoBin, { recursive: true });
    await writeFile(envFile, '', 'utf8');

    await updateClaudeEnvPath({ CLAUDE_ENV_FILE: envFile, CLAUDE_PROJECT_DIR: projectDir });

    expect(await readFile(envFile, 'utf8')).toBe(createPathExportLine(repoBin, delimiter));
  });
});

describe('Claude protect-generated hook', () => {
  const root = join('/workspace', 'mangostudio');

  it.each([
    ['CHANGELOG.md', 'bun run changelog'],
    ['packages/protocol/CHANGELOG.md', 'bun run protocol:release:prepare'],
    ['apps/frontend/src/routeTree.gen.ts', 'bun run --filter @mangostudio/frontend routes'],
    ['bun.lock', 'bun install'],
    ['Cargo.lock', 'cargo update'],
    ['crates/mango-protocol/fuzz/Cargo.lock', 'cargo update -w --manifest-path'],
    ['apps/shared/src/runtime-contract/generated/catalog.json', 'bun run contracts:emit'],
  ])('protects generated file %s', (path, regenerate) => {
    const match = findProtectedFile(join(root, path), root);

    expect(match?.path).toBe(path);
    expect(match?.regenerate).toContain(regenerate);
  });

  it('protects generated files inside a nested agent worktree', () => {
    const match = findProtectedFile(join(root, '.claude', 'worktrees', 'wt', 'bun.lock'), root);

    expect(match?.path).toBe('bun.lock');
  });

  it('allows hand-written files and files outside the repo', () => {
    expect(findProtectedFile(join(root, 'apps', 'api', 'src', 'app.ts'), root)).toBeUndefined();
    expect(findProtectedFile(join(root, 'docs', 'CHANGELOG-notes.md'), root)).toBeUndefined();
    expect(findProtectedFile(join('/workspace', 'other', 'CHANGELOG.md'), root)).toBeUndefined();
  });

  it('blocks a protected edit with the path and the regeneration command', () => {
    const input = JSON.stringify({ tool_input: { file_path: join(root, 'CHANGELOG.md') } });

    const result = runProtectGeneratedHook(input, root);

    expect(result.blocked).toBe(true);
    expect(result.message).toContain('CHANGELOG.md');
    expect(result.message).toContain('bun run changelog');
  });

  it('resolves relative edits from the tool working directory', () => {
    const input = JSON.stringify({
      cwd: join(root, 'packages', 'protocol'),
      tool_input: { file_path: 'CHANGELOG.md' },
    });
    expect(runProtectGeneratedHook(input, root).message).toContain(
      'bun run protocol:release:prepare'
    );
    const outside = JSON.stringify({
      cwd: '/workspace/other',
      tool_input: { file_path: 'CHANGELOG.md' },
    });
    expect(runProtectGeneratedHook(outside, root).blocked).toBe(false);
  });

  it('falls back to the repo root for a repo-relative path from a nested cwd', () => {
    const input = JSON.stringify({
      cwd: join(root, 'packages', 'protocol'),
      tool_input: { file_path: 'packages/protocol/CHANGELOG.md' },
    });

    expect(runProtectGeneratedHook(input, root).message).toContain(
      'bun run protocol:release:prepare'
    );
  });

  it('lets unprotected and unparseable payloads through', () => {
    const input = JSON.stringify({ tool_input: { file_path: join(root, 'README.md') } });

    expect(runProtectGeneratedHook(input, root)).toEqual({ blocked: false, message: '' });
    expect(runProtectGeneratedHook('not json', root)).toEqual({ blocked: false, message: '' });
  });

  it('exits with code 2 and a stderr reason when run as a Claude hook', async () => {
    const proc = Bun.spawn(
      [process.execPath, join(repoRoot, '.claude', 'hooks', 'protect-generated.mjs')],
      { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }
    );
    await proc.stdin.write(
      JSON.stringify({ tool_input: { file_path: join(repoRoot, 'bun.lock') } })
    );
    await proc.stdin.end();

    expect(await proc.exited).toBe(2);
    expect(await new Response(proc.stderr).text()).toContain('bun install');
  });
});
