/**
 * The two onboarding commands run against a real `sh`, not asserted as strings.
 *
 * Both are shell that has to behave, not shell that has to read a certain way:
 * a background job silently losing stdin, a bounded wait that never ends, an
 * exit status masked by the kill that follows it. Asserting on the text would
 * miss every one of those, so these execute the generated scripts the way the
 * ssh runner does — `sh -c <script> sh <args…>` — against a fake runtime in a
 * temporary `HOME`.
 *
 * Posix-only by construction: these target the far side of `ssh`, which is a
 * posix shell even when the hub is Windows.
 */

import { describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_SSH_RUNTIME_PATH } from '@mangostudio/shared/environments';
import {
  buildConnectBootstrapCommand,
  buildServiceInstallCommand,
} from '../../../../src/modules/environments/domain/remote-bootstrap-commands';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

const HUB_ENDPOINT = 'wss://hub.example.com/api/runtime';
const TOKEN = 'mrt_selector.secret-value';

interface ShellRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Mirrors how the ssh runner invokes a script. */
function runScript(
  script: string,
  home: string,
  args: readonly string[],
  stdin?: string
): ShellRun {
  const result = Bun.spawnSync({
    cmd: ['sh', '-c', script, 'sh', ...args],
    env: { ...process.env, HOME: home, XDG_RUNTIME_DIR: '', DBUS_SESSION_BUS_ADDRESS: '' },
    ...(stdin === undefined ? {} : { stdin: new TextEncoder().encode(stdin) }),
  });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

/**
 * Shortens the bootstrap's wait so the kill path is exercised in seconds.
 * The window is a constant in the command, not a parameter — a knob that only
 * tests would ever turn is worse than a rewrite the test states outright.
 */
function withWindow(script: string, seconds: number): string {
  const shortened = script.replace('-lt 8', `-lt ${seconds}`);
  expect(shortened).not.toBe(script);
  return shortened;
}

/**
 * A stand-in for `mangostudio-runtime` at the managed slot path. It records the
 * argv it was given and whatever reached it on stdin, then behaves the way the
 * scenario asks: staying alive like a real `connect`, or exiting.
 */
function fakeRuntime(behaviour: string): {
  readonly home: string;
  readonly argvPath: string;
  readonly stdinPath: string;
} {
  const home = mkdtempSync(join(tmpdir(), 'mango-bootstrap-'));
  const binary = join(home, '.mango/runtime/remote/current/mangostudio-runtime');
  const argvPath = join(home, 'argv');
  const stdinPath = join(home, 'stdin');
  mkdirSync(dirname(binary), { recursive: true });
  writeFileSync(
    binary,
    `#!/bin/sh
printf '%s\\n' "$@" > ${JSON.stringify(argvPath)}
cat > ${JSON.stringify(stdinPath)}
${behaviour}
`
  );
  chmodSync(binary, 0o755);
  return { home, argvPath, stdinPath };
}

describePosix('buildConnectBootstrapCommand', () => {
  it('delivers the token on stdin and stops a runtime that keeps running', () => {
    const fake = fakeRuntime('sleep 30');
    const command = buildConnectBootstrapCommand(DEFAULT_SSH_RUNTIME_PATH, HUB_ENDPOINT);

    const run = runScript(withWindow(command.script, 2), fake.home, [...command.args], TOKEN);

    // A background job in a shell without job control reads /dev/null unless
    // the script hands it a descriptor. This is the assertion that catches it.
    expect(readFileSync(fake.stdinPath, 'utf8')).toBe(TOKEN);
    expect(run.exitCode).toBe(0);
  });

  it('never puts the token in argv', () => {
    const fake = fakeRuntime('sleep 30');
    const command = buildConnectBootstrapCommand(DEFAULT_SSH_RUNTIME_PATH, HUB_ENDPOINT);

    runScript(withWindow(command.script, 2), fake.home, [...command.args], TOKEN);

    const argv = readFileSync(fake.argvPath, 'utf8');
    expect(argv.split('\n').filter(Boolean)).toEqual([
      'connect',
      '--hub',
      HUB_ENDPOINT,
      '--token',
      '-',
    ]);
    expect(argv).not.toContain('secret-value');
    expect(command.args).not.toContain(TOKEN);
  });

  it('propagates the status and stderr of a runtime that refuses', () => {
    const fake = fakeRuntime('echo "The hub refused this runtime." >&2\nexit 1');
    const command = buildConnectBootstrapCommand(DEFAULT_SSH_RUNTIME_PATH, HUB_ENDPOINT);

    const run = runScript(withWindow(command.script, 2), fake.home, [...command.args], TOKEN);

    // Breaking out of the wait early is what keeps this from being masked by
    // the timed kill that would otherwise follow it.
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('The hub refused this runtime.');
  });

  it('expands the managed slot path against the target home', () => {
    const fake = fakeRuntime('exit 0');
    const command = buildConnectBootstrapCommand(DEFAULT_SSH_RUNTIME_PATH, HUB_ENDPOINT);

    const run = runScript(withWindow(command.script, 2), fake.home, [...command.args], TOKEN);

    expect(run.exitCode).toBe(0);
    expect(readFileSync(fake.argvPath, 'utf8')).toContain('connect');
  });
});

describePosix('buildServiceInstallCommand', () => {
  /** Prints the environment it would run with instead of exec'ing the binary. */
  const reportEnvironment = (script: string) =>
    script.replace(
      'exec "$p" service install --mode connect',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion on the target, not a JS placeholder
      'echo "XDG=$XDG_RUNTIME_DIR"; echo "DBUS=${DBUS_SESSION_BUS_ADDRESS:-unset}"'
    );

  it('supplies XDG_RUNTIME_DIR when the ssh session has none', () => {
    const fake = fakeRuntime('exit 0');
    const command = buildServiceInstallCommand(DEFAULT_SSH_RUNTIME_PATH);

    const run = runScript(reportEnvironment(command.script), fake.home, [...command.args]);

    expect(run.stdout).toContain(`XDG=/run/user/${process.getuid?.()}`);
  });

  it('leaves DBUS_SESSION_BUS_ADDRESS unset when no bus socket exists', () => {
    const fake = fakeRuntime('exit 0');
    const command = buildServiceInstallCommand(DEFAULT_SSH_RUNTIME_PATH);

    // An address pointing at nothing would satisfy the runtime's session-bus
    // check and trade its precise refusal for a systemd connection error. The
    // runtime dir is pinned at an empty directory rather than left to default:
    // a developer machine with a live session really does have /run/user/<uid>/bus.
    const result = Bun.spawnSync({
      cmd: ['sh', '-c', reportEnvironment(command.script), 'sh', ...command.args],
      env: {
        ...process.env,
        HOME: fake.home,
        XDG_RUNTIME_DIR: fake.home,
        DBUS_SESSION_BUS_ADDRESS: '',
      },
    });

    const stdout = new TextDecoder().decode(result.stdout);
    expect(stdout).toContain(`XDG=${fake.home}`);
    expect(stdout).toContain('DBUS=unset');
  });

  it('keeps a session bus the ssh session already carries', () => {
    const fake = fakeRuntime('exit 0');
    const command = buildServiceInstallCommand(DEFAULT_SSH_RUNTIME_PATH);

    const result = Bun.spawnSync({
      cmd: ['sh', '-c', reportEnvironment(command.script), 'sh', ...command.args],
      env: {
        ...process.env,
        HOME: fake.home,
        XDG_RUNTIME_DIR: '/run/user/existing',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/already/there',
      },
    });

    const stdout = new TextDecoder().decode(result.stdout);
    expect(stdout).toContain('XDG=/run/user/existing');
    expect(stdout).toContain('DBUS=unix:path=/already/there');
  });

  it('runs the install with the mode as a constant, never as user input', () => {
    const fake = fakeRuntime('exit 0');
    const command = buildServiceInstallCommand(DEFAULT_SSH_RUNTIME_PATH);

    const run = runScript(command.script, fake.home, [...command.args]);

    expect(run.exitCode).toBe(0);
    expect(readFileSync(fake.argvPath, 'utf8').split('\n').filter(Boolean)).toEqual([
      'service',
      'install',
      '--mode',
      'connect',
    ]);
    expect(command.args).toEqual([DEFAULT_SSH_RUNTIME_PATH]);
  });
});
