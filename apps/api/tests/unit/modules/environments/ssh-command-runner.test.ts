import { describe, expect, it } from 'bun:test';
import { SSH_FORCED_OPTIONS } from '@mangostudio/shared/environments';
import { createSshCommandRunner } from '../../../../src/modules/environments/infrastructure/ssh-command-runner';

describe('createSshCommandRunner', () => {
  it('exposes a runner bound to an SSH config', () => {
    const runner = createSshCommandRunner({ host: 'build-01.internal', user: 'deploy' });
    expect(typeof runner).toBe('function');
    expect(SSH_FORCED_OPTIONS).toContain('BatchMode=yes');
  });

  it('refuses to start when ssh is missing from PATH (argv still code-defined)', async () => {
    const previous = process.env.PATH;
    process.env.PATH = '';
    try {
      const runner = createSshCommandRunner({ host: 'localhost' });
      await expect(runner('true')).rejects.toBeInstanceOf(Error);
    } finally {
      process.env.PATH = previous;
    }
  });
});
