/**
 * Read-only command behaviour through the real Hub codec and compiled Rust host.
 *
 * The expected results were recorded from the retired in-process TypeScript
 * runtime answering the same calls (bash on Linux). `durationMs` is the only
 * field dropped, as before; paths and vendor-CLI output are machine-dependent
 * and are rebuilt from the scratch home or read from the CLI itself.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { rejectionOf } from '@mangostudio/protocol/testing';
import type { RuntimeShellResult } from '@mangostudio/shared/runtime-contract';
import type { RuntimeClient } from '../../../src/services/runtime-client/runtime-client';
import { ToolArgumentError } from '../../../src/services/tools/arg-parsing';
import {
  cleanupMangoHome,
  resolveRustRuntimeBinary,
  scratchMangoHome,
} from '../../support/rust-runtime-binary';
import {
  type SpawnedRustRuntimeClient,
  spawnRustRuntimeClient,
} from '../../support/rust-runtime-client';

const binary = resolveRustRuntimeBinary();
const kind: 'powershell' | 'bash' = process.platform === 'win32' ? 'powershell' : 'bash';

function semanticShell(result: RuntimeShellResult): Omit<RuntimeShellResult, 'durationMs'> {
  const { durationMs, ...semantic } = result;
  expect(durationMs).toBeGreaterThanOrEqual(0);
  return semantic;
}

type SemanticShell = Omit<RuntimeShellResult, 'durationMs'>;

/** A recorded TypeScript answer, stamped with the shell and command this platform ran. */
function recordedShell(
  command: string,
  recorded: Omit<SemanticShell, 'shell' | 'command'>
): SemanticShell {
  return { shell: kind, command, ...recorded };
}

/** What `binary args` prints when run directly: the recorded shape of a gh or git pass-through. */
function directRun(binaryName: string, args: readonly string[], cwd: string) {
  const proc = Bun.spawnSync([binaryName, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    exitCode: proc.exitCode,
  };
}

describe.skipIf(!binary.available)('Rust command parity', () => {
  let home = '';
  let previousHome: string | undefined;
  let previousFixture: string | undefined;
  let runtime: SpawnedRustRuntimeClient | undefined;
  let rust: RuntimeClient;

  beforeAll(async () => {
    previousHome = process.env.MANGO_HOME;
    previousFixture = process.env.MANGO_COMMAND_FIXTURE;
    home = await scratchMangoHome('command-compat');
    process.env.MANGO_HOME = home;
    process.env.MANGO_COMMAND_FIXTURE = 'fixture value';
    await writeFile(join(home, 'first.txt'), 'first\n');
    await writeFile(join(home, 'second.txt'), 'second\n');
    runtime = await spawnRustRuntimeClient(binary.path, 'command-compat');
    rust = runtime.client;
  }, 30_000);

  afterAll(async () => {
    await runtime?.close();
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
      { exitCode: 0, signal: null, stdout: 'stdout', stderr: 'stderr', truncated: false },
    ],
    [
      'exit 7',
      'exit 7',
      4096,
      { exitCode: 7, signal: null, stdout: '', stderr: '', truncated: false },
    ],
    [
      "printf '%s' 'abcdefg'",
      "[Console]::Out.Write('abcdefg')",
      4,
      { exitCode: 0, signal: null, stdout: 'abcd', stderr: '', truncated: true },
    ],
    [
      "printf '\\357\\273\\277text'",
      "[Console]::Out.Write([char]0xFEFF + 'text')",
      4096,
      // Windows PowerShell writes U+FEFF through a console code page that
      // cannot carry it, so both runtimes answered '?text' on the Windows leg.
      {
        exitCode: 0,
        signal: null,
        stdout: process.platform === 'win32' ? '?text' : 'text',
        stderr: '',
        truncated: false,
      },
    ],
  ] as const)(
    'preserves shell output, exit and byte cap: %s',
    async (posix, windows, maxOutputBytes, recorded) => {
      const params = {
        kind,
        command: kind === 'powershell' ? windows : posix,
        cwd: home,
        timeoutMs: 5000,
        maxOutputBytes,
      };
      expect(semanticShell(await rust.shell.run(params))).toEqual(
        recordedShell(params.command, { ...recorded, termination: { kind: 'exited' } })
      );
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
    expect(semanticShell(await rust.shell.run(params))).toEqual(
      recordedShell(params.command, {
        // A job-object termination on Windows reports exit code 1 and no
        // signal; POSIX reports the SIGKILL that ended the process group.
        ...(process.platform === 'win32'
          ? { exitCode: 1, signal: null }
          : { exitCode: null, signal: 'SIGKILL' }),
        stdout: '',
        stderr: '',
        truncated: true,
        termination: { kind: 'timed_out' },
      })
    );
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
      expect(semanticShell(await rust.shell.run(params))).toEqual(
        recordedShell(params.command, {
          exitCode: null,
          signal: 'SIGKILL',
          stdout: '',
          stderr: '',
          truncated: false,
          termination: { kind: 'timed_out' },
        })
      );
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
        expect(semanticShell(await rust.shell.run(params, { timeoutMs: 5000 }))).toEqual(
          recordedShell(command, {
            exitCode: 0,
            signal: null,
            stdout,
            stderr,
            truncated: true,
            termination: { kind: 'exited' },
          })
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
    expect(semanticShell(await rust.shell.run(params))).toEqual(
      recordedShell(command, {
        exitCode: 0,
        signal: null,
        stdout: '',
        stderr: '',
        truncated: false,
        termination: { kind: 'exited' },
      })
    );
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
    const first = join(home, 'first.txt');
    const second = join(home, 'second.txt');
    // Recorded on POSIX, where git prints an absolute path as `a` + the path;
    // Windows drive paths print differently, so there the recorded shape is git's own.
    const expected =
      process.platform === 'win32'
        ? directRun('git', params.args, home)
        : {
            stdout:
              `diff --git a${first} b${second}\n` +
              'index 9c59e24..e019be0 100644\n' +
              `--- a${first}\n` +
              `+++ b${second}\n` +
              '@@ -1 +1 @@\n' +
              '-first\n' +
              '+second\n',
            stderr: '',
            exitCode: 1,
          };
    expect(expected.exitCode).toBe(1);
    expect(await rust.git.exec(params)).toEqual(expected);
  });

  it.skipIf(!Bun.which('gh'))(
    'preserves gh reads and mutation-method help without contacting GitHub',
    async () => {
      // The installed gh's version and help text vary by machine, so the
      // recorded shape is gh's own direct output: stdout verbatim, no stderr, exit 0.
      const read = { args: ['--version'], cwd: home };
      const expectedRead = directRun('gh', read.args, home);
      expect(expectedRead).toMatchObject({
        stdout: expect.stringMatching(/^gh version /),
        stderr: '',
        exitCode: 0,
      });
      expect(await rust.gh.exec(read)).toEqual(expectedRead);
      const help = { args: ['pr', 'create', '--help'], cwd: home };
      const expectedHelp = directRun('gh', help.args, home);
      expect(expectedHelp).toMatchObject({
        stdout: expect.stringContaining('gh pr create [flags]'),
        stderr: '',
        exitCode: 0,
      });
      expect(await rust.gh.mutate(help)).toEqual(expectedHelp);
    }
  );

  it('rejects unsupported gh operations and unpinned queries at the same typed boundary', async () => {
    for (const args of [
      ['pr', 'private rejected prose'],
      ['api', 'graphql', '-f', 'query=query { viewer { login } }'],
    ]) {
      expect(await rejectionOf(rust.gh.exec({ args, cwd: home }))).toBeInstanceOf(
        ToolArgumentError
      );
    }
  });
});
