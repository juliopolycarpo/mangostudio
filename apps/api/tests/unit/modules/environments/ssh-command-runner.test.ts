import { describe, expect, it } from 'bun:test';
import { SSH_FORCED_OPTIONS } from '@mangostudio/shared/environments';
import { createSshCommandRunner } from '../../../../src/modules/environments/infrastructure/ssh-command-runner';

describe('createSshCommandRunner', () => {
  it('exposes a runner bound to an SSH config with forced BatchMode options', () => {
    const runner = createSshCommandRunner({ host: 'build-01.internal', user: 'deploy' });
    expect(typeof runner).toBe('function');
    expect(SSH_FORCED_OPTIONS).toContain('BatchMode=yes');
    expect(SSH_FORCED_OPTIONS).toContain('RemoteCommand=none');
  });
});
