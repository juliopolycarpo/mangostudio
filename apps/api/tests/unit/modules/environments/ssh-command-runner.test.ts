import { describe, expect, it } from 'bun:test';
import { quoteForRemoteShell, SSH_FORCED_OPTIONS } from '@mangostudio/shared/environments';
import {
  buildSshRemoteCommand,
  createSshCommandRunner,
} from '../../../../src/modules/environments/infrastructure/ssh-command-runner';

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
