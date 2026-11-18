import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { quoteForRemoteShell, SSH_FORCED_OPTIONS } from '@mangostudio/shared/environments';

import {
  buildSshRemoteCommand,
  createSshCommandRunner,
  type SshChild,
} from '../../../../src/modules/environments/infrastructure/ssh-command-runner';

/**
 * A stand-in for the `ssh` child the runner drives: real streams, and a test
 * that decides when the process exits. Records the argv it was started with
 * and what the runner wrote to stdin.
 */
class FakeSshChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killedWith: string[] = [];
  readonly written: Buffer[] = [];
  startedWith: readonly string[] = [];

  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => this.written.push(chunk));
  }

  kill(signal: string): boolean {
    this.killedWith.push(signal);
    return true;
  }

  /** The launcher dependency the runner is built with. */
  readonly spawnSsh = (args: readonly string[]): SshChild => {
    this.startedWith = args;
    return this as unknown as SshChild;
  };

  exit(code: number): void {
    this.stdout.end();
    this.stderr.end();
    this.emit('close', code, null);
  }
}

describe('createSshCommandRunner with an injected launcher', () => {
  it('starts the launcher with the forced options, the destination and one quoted command', async () => {
    const fake = new FakeSshChild();
    const run = createSshCommandRunner(
      { host: 'build-01.internal', user: 'deploy', port: 2222, identityFile: '/k/id' },
      { spawnSsh: fake.spawnSsh }
    );

    const pending = run('echo "$1"', { args: ['a b'] });
    fake.stdout.write('hello');
    fake.exit(0);

    expect(await pending).toEqual({ stdout: 'hello', stderr: '', exitCode: 0 });
    expect(fake.startedWith).toEqual([
      ...SSH_FORCED_OPTIONS,
      '-o',
      'IdentitiesOnly=yes',
      '-i',
      '/k/id',
      '-p',
      '2222',
      '-T',
      '--',
      'deploy@build-01.internal',
      buildSshRemoteCommand('echo "$1"', ['a b']),
    ]);
  });

  it('ignores an EPIPE on stdin that arrives after the write settled', async () => {
    const fake = new FakeSshChild();
    const controller = new AbortController();
    const run = createSshCommandRunner({ host: 'h' }, { spawnSsh: fake.spawnSsh });

    // Abort from the progress callback, as a cancelled push does: the chunk is
    // already written when the child is killed.
    const pending = run('cat > f', {
      stdin: new TextEncoder().encode('payload'),
      signal: controller.signal,
      onStdinProgress: () => controller.abort(),
    });
    await Bun.sleep(0);
    fake.exit(1);
    await pending;

    expect(fake.killedWith).toEqual(['SIGKILL']);
    // The kernel reports the broken pipe only now. With no listener left on
    // stdin this emit throws, which in the hub is an uncaught exception.
    expect(() => fake.stdin.emit('error', new Error('EPIPE: broken pipe, write'))).not.toThrow();
  });
});

describe('createSshCommandRunner', () => {
  it('exposes a runner bound to an SSH config with forced BatchMode options', () => {
    const runner = createSshCommandRunner({ host: 'build-01.internal', user: 'deploy' });
    expect(typeof runner).toBe('function');
    expect(SSH_FORCED_OPTIONS).toContain('BatchMode=yes');
    expect(SSH_FORCED_OPTIONS).toContain('RemoteCommand=none');
  });
});

describe('buildSshRemoteCommand', () => {
  it('builds one quoted remote command so multi-statement scripts stay one -c operand', () => {
    const script = 'set -e; echo "$1"; mkdir -p "$2"';
    const remote = buildSshRemoteCommand(script, ['1.2.3', 'dir with spaces']);

    expect(remote).toBe(
      [
        'sh',
        '-c',
        quoteForRemoteShell(script),
        'sh',
        quoteForRemoteShell('1.2.3'),
        quoteForRemoteShell('dir with spaces'),
      ].join(' ')
    );
    expect(remote.startsWith('sh -c ')).toBe(true);
    // The script is a single shell word after -c, not split on spaces/semicolons.
    expect(remote).toContain(quoteForRemoteShell(script));
    expect(remote.split(' ').filter((part) => part === 'sh')).toHaveLength(2);
  });
});
