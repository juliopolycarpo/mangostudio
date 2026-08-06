/**
 * Self-skipping checks for the two onboarding commands against localhost sshd.
 *
 * The unit tests run the same scripts under a local `sh`; these run them
 * through a real ssh channel, which is where the two properties that matter
 * only hold end to end: a pairing token piped into `ssh` reaches the remote
 * process on its stdin and appears in no argv on the way, and a
 * non-interactive session — which really does arrive without `XDG_RUNTIME_DIR`
 * — still gets one by the time `service install` runs.
 *
 * The remote `HOME` is a temporary directory, so nothing here touches the
 * developer's own `~/.mango`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { quoteForRemoteShell, type SshEnvironmentConfig } from '@mangostudio/shared/environments';
import {
  buildConnectBootstrapCommand,
  buildServiceInstallCommand,
} from '../../../src/modules/environments/domain/remote-bootstrap-commands';
import type { RuntimeCommandOptions } from '../../../src/modules/environments/domain/runtime-push';
import { createSshCommandRunner } from '../../../src/modules/environments/infrastructure/ssh-command-runner';

const HUB_ENDPOINT = 'wss://hub.example.com/api/runtime';
const TOKEN = 'mrt_selector.secret-value';

/**
 * The fake runtime is addressed absolutely, not as `~/…`.
 *
 * `quoteForRemoteShell` deliberately leaves a leading `~/` outside its quotes so
 * the target's login shell expands it — which it does *before* the script runs,
 * against the real account home. An isolated `HOME` exported inside the script
 * therefore cannot redirect a tilde path, and a test that tried would reach for
 * the developer's own `~/.mango`.
 */
function fakeBinaryPath(home: string): string {
  return `${home}/.mango/runtime/remote/current/mangostudio-runtime`;
}

const hasSshClient = Bun.which('ssh') !== null;
const canReachLocalhost = hasSshClient && (await probeLocalhost());

async function probeLocalhost(): Promise<boolean> {
  const child = Bun.spawn(
    [
      'ssh',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=5',
      '-o',
      'StrictHostKeyChecking=yes',
      '-T',
      '--',
      'localhost',
      'true',
    ],
    { stdout: 'ignore', stderr: 'ignore' }
  );
  return (await child.exited) === 0;
}

const config: SshEnvironmentConfig = { host: 'localhost' };
let remoteHome = '';

/** Runs a script with the isolated HOME the fake runtime was installed under. */
function isolated(script: string, options?: RuntimeCommandOptions) {
  return createSshCommandRunner(config)(
    `export HOME=${quoteForRemoteShell(remoteHome)}; ${script}`,
    options
  );
}

/**
 * Writes a stand-in for `mangostudio-runtime` at the managed slot path. It
 * records its argv and stdin, then behaves as the scenario needs — `connect`
 * has to stay alive for the bootstrap's bounded wait to mean anything.
 */
async function installFakeRuntime(behaviour: string): Promise<void> {
  const script = `set -e
mkdir -p "$HOME/.mango/runtime/remote/current"
cat > ${quoteForRemoteShell(fakeBinaryPath(remoteHome))} <<'FAKE'
#!/bin/sh
printf '%s\\n' "$@" > "$HOME/argv"
printf '%s' "XDG=\${XDG_RUNTIME_DIR:-unset}" > "$HOME/env"
cat > "$HOME/stdin"
${behaviour}
FAKE
chmod +x ${quoteForRemoteShell(fakeBinaryPath(remoteHome))}
rm -f "$HOME/argv" "$HOME/stdin" "$HOME/env"`;
  const result = await isolated(script);
  if (result.exitCode !== 0) {
    throw new Error(`Could not install the fake runtime: ${result.stderr || result.stdout}`);
  }
}

async function readRemote(name: string): Promise<string> {
  const result = await isolated(`cat "$HOME/${name}" 2>/dev/null || true`);
  return result.stdout;
}

beforeAll(async () => {
  if (!canReachLocalhost) return;
  const created = await createSshCommandRunner(config)('mktemp -d /tmp/mango-onboarding-XXXXXX');
  if (created.exitCode !== 0) {
    throw new Error(`Could not create isolated remote HOME: ${created.stderr}`);
  }
  remoteHome = created.stdout.trim();
});

afterAll(async () => {
  if (!canReachLocalhost || !remoteHome) return;
  await createSshCommandRunner(config)(`rm -rf -- ${quoteForRemoteShell(remoteHome)}`).catch(
    () => undefined
  );
});

describe('machine onboarding over a real sshd', () => {
  it.skipIf(!canReachLocalhost)(
    'delivers the pairing token on stdin and keeps it out of every argv',
    async () => {
      await installFakeRuntime('sleep 30');
      const command = buildConnectBootstrapCommand(fakeBinaryPath(remoteHome), HUB_ENDPOINT);

      const result = await isolated(command.script, {
        args: [...command.args],
        stdin: new TextEncoder().encode(TOKEN),
        timeoutMs: 60_000,
      });

      expect(result.exitCode).toBe(0);
      expect(await readRemote('stdin')).toBe(TOKEN);
      const argv = (await readRemote('argv')).split('\n').filter(Boolean);
      expect(argv).toEqual(['connect', '--hub', HUB_ENDPOINT, '--token', '-']);
      // The token is in no argv on either side of the channel: not in the
      // command this hub constructed, and not in what the remote process was
      // started with — which is what `ps` on that machine would show.
      expect(command.args).not.toContain(TOKEN);
      expect(command.script).not.toContain(TOKEN);
    },
    120_000
  );

  it.skipIf(!canReachLocalhost)(
    'propagates the status of a runtime that refuses the credential',
    async () => {
      await installFakeRuntime('echo "The hub refused this runtime." >&2\nexit 1');
      const command = buildConnectBootstrapCommand(fakeBinaryPath(remoteHome), HUB_ENDPOINT);

      const result = await isolated(command.script, {
        args: [...command.args],
        stdin: new TextEncoder().encode(TOKEN),
        timeoutMs: 60_000,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('The hub refused this runtime.');
    },
    120_000
  );

  it.skipIf(!canReachLocalhost)(
    'gives service install a runtime dir the ssh session never had',
    async () => {
      await installFakeRuntime('exit 0');
      // A non-interactive `ssh host command` really does arrive without one;
      // this is the session the workaround exists for.
      const bare = await createSshCommandRunner(config)(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion on the target, not a JS placeholder
        'echo "${XDG_RUNTIME_DIR:-unset}"'
      );
      expect(bare.stdout.trim()).toBe('unset');

      const command = buildServiceInstallCommand(fakeBinaryPath(remoteHome));
      const result = await isolated(command.script, { args: [...command.args], timeoutMs: 60_000 });

      expect(result.exitCode).toBe(0);
      expect((await readRemote('argv')).split('\n').filter(Boolean)).toEqual([
        'service',
        'install',
        '--mode',
        'connect',
      ]);
      expect(await readRemote('env')).toContain(`XDG=/run/user/`);
    },
    120_000
  );
});
