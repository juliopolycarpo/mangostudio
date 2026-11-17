import { describe, expect, it } from 'bun:test';

import {
  classifyRemoteFailure,
  type RemoteFailureReason,
} from '../../../../src/modules/environments/domain/remote-failure';

interface Sample {
  readonly label: string;
  readonly exitCode?: number;
  readonly output: string;
  readonly reason: RemoteFailureReason;
}

/** stderr as OpenSSH 9.x and a POSIX shell actually print it. */
const SAMPLES: readonly Sample[] = [
  {
    label: 'changed host key banner',
    exitCode: 255,
    output:
      '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\nHost key verification failed.\n',
    reason: 'host-key-mismatch',
  },
  {
    label: 'unknown host key with StrictHostKeyChecking',
    exitCode: 255,
    output:
      'No ED25519 host key is known for build.example and you have requested strict checking.\nHost key verification failed.',
    reason: 'host-key-mismatch',
  },
  {
    label: 'publickey refused',
    exitCode: 255,
    output: 'alice@build.example: Permission denied (publickey,password).',
    reason: 'auth-failed',
  },
  {
    label: 'too many authentication failures',
    exitCode: 255,
    output: 'Received disconnect from 10.0.0.5 port 22:2: Too many authentication failures',
    reason: 'auth-failed',
  },
  {
    label: 'name does not resolve',
    exitCode: 255,
    output: 'ssh: Could not resolve hostname build.example: Name or service not known',
    reason: 'host-unreachable',
  },
  {
    label: 'connection refused',
    exitCode: 255,
    output: 'ssh: connect to host build.example port 22: Connection refused',
    reason: 'host-unreachable',
  },
  {
    label: 'connection timed out',
    exitCode: 255,
    output: 'ssh: connect to host build.example port 22: Connection timed out',
    reason: 'host-unreachable',
  },
  {
    label: 'dropped before the banner',
    exitCode: 255,
    output: 'kex_exchange_identification: read: Connection reset by peer',
    reason: 'host-unreachable',
  },
  {
    label: 'remote rm refused on the slot directory',
    exitCode: 1,
    output: "rm: cannot remove '/home/alice/.mango/runtime/host': Permission denied",
    reason: 'remote-permission-denied',
  },
  {
    label: 'client warning before the real failure',
    exitCode: 255,
    output:
      'Warning: Identity file /home/alice/.ssh/id_missing not accessible: No such file or directory.\nalice@build.example: Permission denied (publickey).',
    reason: 'auth-failed',
  },
  {
    label: 'remote script failure with its own wording',
    exitCode: 2,
    output: 'rm: unexpected failure in slot cleanup',
    reason: 'remote-command-failed',
  },
  {
    // A German locale prints none of the English signatures; guessing would be
    // worse than the generic message.
    label: 'localized OpenSSH line',
    exitCode: 255,
    output: 'alice@build.example: Zugriff verweigert (publickey).',
    reason: 'remote-command-failed',
  },
  {
    label: 'prefixed line that only resembles a marker',
    exitCode: 255,
    output: 'sshd-session[411]: authenticator rejected request',
    reason: 'remote-command-failed',
  },
  { label: 'empty stderr', exitCode: 255, output: '', reason: 'remote-command-failed' },
];

describe('classifyRemoteFailure', () => {
  for (const sample of SAMPLES) {
    it(`${sample.label}: ${sample.reason}`, () => {
      const failure = classifyRemoteFailure({
        output: sample.output,
        ...(sample.exitCode === undefined ? {} : { exitCode: sample.exitCode }),
      });

      expect(
        failure.reason,
        `(classifyRemoteFailure): expected reason ${sample.reason} | received: ${failure.reason} for ${JSON.stringify(sample.output)}`
      ).toBe(sample.reason);
      // Fixed copy: ends with the log pointer and never repeats what was read.
      expect(failure.message.endsWith('Details are in the hub log.')).toBe(true);
      expect(failure.message).not.toContain('alice');
      expect(failure.message).not.toContain('build.example');
      expect(failure.message).not.toContain('/home');
    });
  }

  it('names the numeric exit code, and only that, in the default message', () => {
    const failure = classifyRemoteFailure({ exitCode: 23, output: 'secret /home/alice detail' });

    expect(failure.message).toContain('(exit code 23)');
    expect(failure.message).not.toContain('secret');
  });

  it('omits the exit code when there is none', () => {
    expect(classifyRemoteFailure({ output: 'boom' }).message).not.toContain('exit code');
  });
});
