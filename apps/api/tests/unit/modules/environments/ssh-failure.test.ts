import { describe, expect, it } from 'bun:test';
import { RUNTIME_SETUP_PENDING_MESSAGE } from '@mangostudio/runtime';
import type { SshEnvironmentConfig, SshFailureReason } from '@mangostudio/shared/environments';
import {
  classifySshFailure,
  describeSshFailure,
} from '../../../../src/modules/environments/domain/ssh-failure';

const CONFIG: SshEnvironmentConfig = { host: 'build-01.internal', user: 'deploy' };

function classify(stderr: string, exitCode: number | null = 255): SshFailureReason {
  return classifySshFailure({ stderr, exitCode });
}

/**
 * Message forms OpenSSH actually emits. `ssh` exits 255 for every failure of
 * its own, so the exit code is the same across the first four rows and only
 * stderr tells them apart.
 */
const FIXTURES: readonly {
  readonly name: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly reason: SshFailureReason;
}[] = [
  {
    name: 'public key refused',
    stderr: 'deploy@build-01.internal: Permission denied (publickey).',
    exitCode: 255,
    reason: 'auth-refused',
  },
  {
    name: 'batch mode with no usable method',
    stderr:
      'deploy@build-01.internal: Permission denied (publickey,password,keyboard-interactive).',
    exitCode: 255,
    reason: 'auth-refused',
  },
  {
    name: 'windows openssh auth refusal',
    stderr: 'No supported authentication methods available (server sent: publickey)',
    exitCode: 255,
    reason: 'auth-refused',
  },
  {
    name: 'unknown host key under strict checking',
    stderr:
      'No ED25519 host key is known for build-01.internal and you have requested strict checking.\nHost key verification failed.',
    exitCode: 255,
    reason: 'host-key-unverified',
  },
  {
    name: 'changed host key',
    stderr:
      '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\nHost key verification failed.',
    exitCode: 255,
    reason: 'host-key-unverified',
  },
  {
    name: 'name does not resolve',
    stderr: 'ssh: Could not resolve hostname build-01.internal: Name or service not known',
    exitCode: 255,
    reason: 'unreachable',
  },
  {
    name: 'connect timeout',
    stderr: 'ssh: connect to host build-01.internal port 22: Connection timed out',
    exitCode: 255,
    reason: 'unreachable',
  },
  {
    name: 'nothing listening',
    stderr: 'ssh: connect to host build-01.internal port 22: Connection refused',
    exitCode: 255,
    reason: 'unreachable',
  },
  {
    name: 'no route',
    stderr: 'ssh: connect to host 10.0.0.9 port 22: No route to host',
    exitCode: 255,
    reason: 'unreachable',
  },
  {
    name: 'remote binary absent (bash)',
    stderr:
      'bash: line 1: /home/deploy/.mango/runtime/remote/current/mangostudio-runtime: No such file or directory',
    exitCode: 127,
    reason: 'runtime-missing',
  },
  {
    name: 'remote binary absent (dash)',
    stderr: 'sh: 1: /home/deploy/.mango/runtime/remote/current/mangostudio-runtime: not found',
    exitCode: 127,
    reason: 'runtime-missing',
  },
  {
    name: 'remote binary without the executable bit',
    stderr: 'bash: line 1: /home/deploy/bin/mangostudio-runtime: Permission denied',
    exitCode: 126,
    reason: 'runtime-not-executable',
  },
];

describe('classifySshFailure', () => {
  for (const fixture of FIXTURES) {
    it(`reads ${fixture.name} as ${fixture.reason}`, () => {
      expect(classifySshFailure({ stderr: fixture.stderr, exitCode: fixture.exitCode })).toBe(
        fixture.reason
      );
    });
  }

  it('reports a missing ssh client from the spawn error, before any stderr exists', () => {
    expect(classifySshFailure({ stderr: '', exitCode: null, spawnErrorCode: 'ENOENT' })).toBe(
      'client-missing'
    );
  });

  it('tells a pending consent gate apart from a missing binary', () => {
    // Both arrive as a non-zero remote exit with a path in the message. Sending
    // someone to reinstall a runtime that is already installed, and whose only
    // problem is that nobody has said what it may do, is the wrong fix.
    const reason = classify(`mangostudio-runtime: ${RUNTIME_SETUP_PENDING_MESSAGE}`, 1);

    expect(reason).toBe('setup-pending');
  });

  it('keeps the consent gate even when the shell also complained about a path', () => {
    const reason = classify(
      `bash: line 1: /home/deploy/bin/runtime: No such file or directory\nmangostudio-runtime: ${RUNTIME_SETUP_PENDING_MESSAGE}`,
      1
    );

    expect(reason).toBe('setup-pending');
  });

  it('does not read a non-fatal identity-file warning as a missing runtime', () => {
    // ssh prints this and carries on, so it is usually followed by the failure
    // that actually happened — here an auth refusal.
    const reason = classify(
      'Warning: Identity file /home/j/.ssh/absent not accessible: No such file or directory.\ndeploy@build-01.internal: Permission denied (publickey).'
    );

    expect(reason).toBe('auth-refused');
  });

  it('prefers the host key over a refusal mentioned in the same output', () => {
    const reason = classify(
      'Host key verification failed.\ndeploy@build-01.internal: Permission denied (publickey).'
    );

    expect(reason).toBe('host-key-unverified');
  });

  it('falls back to unknown rather than misreading unfamiliar output', () => {
    // The client's text is locale-dependent in theory; a wrong confident answer
    // is worse than handing back what ssh said.
    expect(classify('ssh: Verbindung zu Host fehlgeschlagen')).toBe('unknown');
    expect(classify('', null)).toBe('unknown');
  });
});

describe('describeSshFailure', () => {
  it('names the manual connect that trusts a host key', () => {
    const message = describeSshFailure(
      'host-key-unverified',
      CONFIG,
      'Host key verification failed.'
    );

    expect(message).toContain('ssh deploy@build-01.internal true');
    expect(message).toContain('known_hosts');
  });

  it('names the configured runtime path when there is nothing to start', () => {
    const message = describeSshFailure(
      'runtime-missing',
      { ...CONFIG, remoteRuntimePath: '~/bin/mangostudio-runtime' },
      ''
    );

    expect(message).toContain('~/bin/mangostudio-runtime');
    expect(message).toContain('--version');
  });

  it('sends a pending machine to setup rather than to a reinstall', () => {
    const message = describeSshFailure('setup-pending', CONFIG, '');

    expect(message).toContain('mangostudio-runtime setup');
    expect(message).not.toContain('Install one there');
  });

  it('attaches ssh output only when it could not be classified', () => {
    expect(describeSshFailure('unknown', CONFIG, 'kex_exchange_identification: bad')).toContain(
      'kex_exchange_identification: bad'
    );
    expect(
      describeSshFailure('auth-refused', CONFIG, 'Permission denied (publickey).')
    ).not.toContain('ssh stderr:');
  });
});
