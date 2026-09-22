/** Read-only command parity through the real Hub codec and compiled Rust host. */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RuntimeShellResult } from '@mangostudio/shared/runtime-contract';
import { resolveRuntimeLaunchCommand } from '../../../src/lib/runtime-paths';
import { connectLocalRuntime } from '../../../src/services/runtime-client/connect-in-process-runtime';
import { RuntimeClient } from '../../../src/services/runtime-client/runtime-client';
import { spawnRuntimeChild } from '../../../src/services/runtime-client/spawn-runtime-child';
import { ToolArgumentError } from '../../../src/services/tools/arg-parsing';
import {
  cleanupMangoHome,
  resolveRustRuntimeBinary,
  rustRuntimeVersion,
  scratchMangoHome,
} from '../../support/rust-runtime-binary';

const binary = resolveRustRuntimeBinary();
const kind: 'powershell' | 'bash' = process.platform === 'win32' ? 'powershell' : 'bash';

function authorizeFixture(): boolean {
  return true;
}
function ignoreNotification(): void {
  /* No UI subscriber in this fixture. */
}

function semanticShell(result: RuntimeShellResult): Omit<RuntimeShellResult, 'durationMs'> {
  const { durationMs, ...semantic } = result;
  expect(durationMs).toBeGreaterThanOrEqual(0);
  return semantic;
}

describe.skipIf(!binary.available)('Rust command parity', () => {
  let home = '';
  let previousHome: string | undefined;
  let previousFixture: string | undefined;
  let rustConnection: Awaited<ReturnType<typeof spawnRuntimeChild>> | undefined;
  let typescriptConnection: Awaited<ReturnType<typeof connectLocalRuntime>> | undefined;
  let rust: RuntimeClient;
  let typescript: RuntimeClient;

  beforeAll(async () => {
    previousHome = process.env.MANGO_HOME;
    previousFixture = process.env.MANGO_COMMAND_FIXTURE;
    home = await scratchMangoHome('command-compat');
    process.env.MANGO_HOME = home;
    process.env.MANGO_COMMAND_FIXTURE = 'fixture value';
    await writeFile(join(home, 'first.txt'), 'first\n');
    await writeFile(join(home, 'second.txt'), 'second\n');
    rustConnection = await spawnRuntimeChild({
      environmentId: 'rust-command-compat',
      launch: resolveRuntimeLaunchCommand(undefined, { MANGOSTUDIO_RUNTIME_BINARY: binary.path }),
      hubVersion: await rustRuntimeVersion(binary.path),
      onClosed: ignoreNotification,
    });
    typescriptConnection = await connectLocalRuntime({
      authorizeWorkspace: authorizeFixture,
      externalAgentIsolation: 'withdrawn',
    });
    rust = new RuntimeClient(rustConnection.hub, ignoreNotification, 'rust-command-compat');
    typescript = new RuntimeClient(
      typescriptConnection.hub,
      ignoreNotification,
      'typescript-command-compat'
    );
  }, 30_000);

  afterAll(async () => {
    await rustConnection?.close();
    await typescriptConnection?.close();
    if (previousHome === undefined) delete process.env.MANGO_HOME;
    else process.env.MANGO_HOME = previousHome;
    if (previousFixture === undefined) delete process.env.MANGO_COMMAND_FIXTURE;
    else process.env.MANGO_COMMAND_FIXTURE = previousFixture;
    if (home) await cleanupMangoHome(home);
  });

  it.each([
    [
      "printf '%s' 'stdout'; printf '%s' 'stderr' >&2",
      "[Console]::Out.Write('stdout'); [Console]::Error.Write('stderr')",
      4096,
    ],
    ['exit 7', 'exit 7', 4096],
    ["printf '%s' 'abcdefg'", "[Console]::Out.Write('abcdefg')", 4],
    ["printf '\\357\\273\\277text'", "[Console]::Out.Write([char]0xFEFF + 'text')", 4096],
  ] as const)(
    'preserves shell output, exit and byte cap: %s',
    async (posix, windows, maxOutputBytes) => {
      const params = {
        kind,
        command: kind === 'powershell' ? windows : posix,
        cwd: home,
        timeoutMs: 5000,
        maxOutputBytes,
      };
      const expected = await typescript.shell.run(params);
      expect(semanticShell(await rust.shell.run(params))).toEqual(semanticShell(expected));
    }
  );

  it('preserves a timed-out shell result', async () => {
    const params = {
      kind,
      command: kind === 'powershell' ? 'Start-Sleep -Seconds 30' : 'sleep 30',
      cwd: home,
      timeoutMs: 2000,
      maxOutputBytes: 4096,
    };
    // Both runtimes wait out the same timeout, so run them side by side.
    const [expected, actual] = await Promise.all([
      typescript.shell.run(params),
      rust.shell.run(params),
    ]);
    expect(expected.termination).toEqual({ kind: 'timed_out' });
    expect(semanticShell(actual)).toEqual(semanticShell(expected));
  }, 10_000);

  it.skipIf(process.platform === 'win32')(
    'keeps completed capture complete after timeout',
    async () => {
      const params = {
        kind,
        command: 'exec 1>&- 2>&-; sleep 30',
        cwd: home,
        timeoutMs: 2000,
        maxOutputBytes: 4096,
      };
      const [expected, actual] = await Promise.all([
        typescript.shell.run(params),
        rust.shell.run(params),
      ]);
      expect(expected.truncated).toBe(false);
      expect(expected.termination).toEqual({ kind: 'timed_out' });
      expect(semanticShell(actual)).toEqual(semanticShell(expected));
    },
    10_000
  );

  describe.skipIf(process.platform === 'win32')('partial capture after leader exit', () => {
    it.each([
      ['printf prefix; (exec 1>&-; sleep 30) &', 'prefix', ''],
      ['printf prefix >&2; (exec 2>&-; sleep 30) &', '', 'prefix'],
      ['printf prefix; sleep 30 &', 'prefix', ''],
    ])(
      'retains arrived bytes when a descendant holds pipes: %s',
      async (command, stdout, stderr) => {
        const params = { kind, command, cwd: home, timeoutMs: 5000, maxOutputBytes: 4096 };
        const expected = await typescript.shell.run(params, { timeoutMs: 5000 });
        expect(expected.stdout).toBe(stdout);
        expect(expected.stderr).toBe(stderr);
        expect(expected.termination).toEqual({ kind: 'exited' });
        expect(semanticShell(await rust.shell.run(params, { timeoutMs: 5000 }))).toEqual(
          semanticShell(expected)
        );
      },
      12_000
    );
  });

  it('applies the environment deny policy at shell launch', async () => {
    const command =
      kind === 'powershell'
        ? '[Console]::Out.Write($env:MANGO_COMMAND_FIXTURE)'
        : 'printf %s "$MANGO_COMMAND_FIXTURE"';
    const params = {
      kind,
      command,
      cwd: home,
      timeoutMs: 5000,
      maxOutputBytes: 4096,
      envPolicy: { deny: ['MANGO_COMMAND_FIXTURE'] },
    };
    const expected = await typescript.shell.run(params);
    expect(expected.stdout).toBe('');
    expect(semanticShell(await rust.shell.run(params))).toEqual(semanticShell(expected));
  });

  it.skipIf(!Bun.which('git'))('preserves direct Git argv and accepted nonzero exits', async () => {
    const params = {
      args: [
        'diff',
        '--no-index',
        '--no-ext-diff',
        '--no-textconv',
        '--color=never',
        '--',
        join(home, 'first.txt'),
        join(home, 'second.txt'),
      ],
      cwd: home,
      acceptedExitCodes: [1],
    };
    const expected = await typescript.git.exec(params);
    expect(expected.exitCode).toBe(1);
    expect(await rust.git.exec(params)).toEqual(expected);
  });

  it.skipIf(!Bun.which('gh'))(
    'preserves gh reads and mutation-method help without contacting GitHub',
    async () => {
      const read = { args: ['--version'], cwd: home };
      expect(await rust.gh.exec(read)).toEqual(await typescript.gh.exec(read));
      const help = { args: ['pr', 'create', '--help'], cwd: home };
      expect(await rust.gh.mutate(help)).toEqual(await typescript.gh.mutate(help));
    }
  );

  it('rejects unsupported gh operations and unpinned queries at the same typed boundary', async () => {
    for (const args of [
      ['pr', 'private rejected prose'],
      ['api', 'graphql', '-f', 'query=query { viewer { login } }'],
    ]) {
      for (const client of [typescript, rust]) {
        await expect(client.gh.exec({ args, cwd: home })).rejects.toBeInstanceOf(ToolArgumentError);
      }
    }
  });
});
