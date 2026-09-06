import { describe, expect, it } from 'bun:test';
import { decideRestart } from '../../../../src/modules/updates/domain/decide-restart';

describe('decideRestart', () => {
  it('reports skipped when the request declined a restart', () => {
    expect(decideRestart({ launch: 'detached', platform: 'linux', restart: false })).toEqual({
      restart: 'skipped',
    });
  });

  it('reports not-running when no live hub owns the state file', () => {
    expect(decideRestart({ launch: null, platform: 'linux', restart: true })).toEqual({
      restart: 'not-running',
    });
  });

  it('reports manual for a foreground hub, on every platform', () => {
    expect(decideRestart({ launch: 'foreground', platform: 'linux', restart: true })).toEqual({
      restart: 'manual',
    });
  });

  it('reports scheduled for a detached hub', () => {
    expect(decideRestart({ launch: 'detached', platform: 'linux', restart: true })).toEqual({
      restart: 'scheduled',
    });
  });

  it('reports scheduled for a POSIX service-managed hub', () => {
    expect(decideRestart({ launch: 'service', platform: 'darwin', restart: true })).toEqual({
      restart: 'scheduled',
    });
  });

  it('refuses a Windows Scheduled Task with the self-restart note', () => {
    expect(decideRestart({ launch: 'service', platform: 'win32', restart: true })).toEqual({
      restart: 'manual',
      message:
        'A Scheduled Task cannot stop or restart itself from inside its own process. ' +
        'Run "mangostudio restart" once this exits.',
    });
  });
});
