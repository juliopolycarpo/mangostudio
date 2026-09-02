import { describe, expect, it } from 'bun:test';
import type { UserServiceStatus } from '@mangostudio/shared/runtime-home';
import {
  type MachineActionsInput,
  machineActions,
} from '../../../../src/modules/machine/domain/machine-actions';
import { evaluateMachineActionGuard } from '../../../../src/modules/machine/domain/machine-guard';

const SERVICE: UserServiceStatus = {
  schemaVersion: 1,
  platform: 'linux',
  unitName: 'mangostudio.service',
  installed: false,
  enabled: false,
  running: false,
};

function input(overrides: Partial<MachineActionsInput> = {}): MachineActionsInput {
  return {
    launch: 'detached',
    platform: 'linux',
    service: SERVICE,
    guard: { allowed: true, reasons: [] },
    secretPersisted: true,
    ...overrides,
  };
}

describe('machineActions', () => {
  it('offers restart and install to a detached hub on a local browser', () => {
    expect(machineActions(input())).toEqual({
      guard: { allowed: true, reasons: [] },
      restart: { available: true, command: 'mangostudio restart' },
      installService: { available: true, command: 'mangostudio service install' },
      uninstallService: {
        available: false,
        command: 'mangostudio service uninstall',
        reason: 'not-installed',
      },
    });
  });

  it('refuses everything with the guard reason when the browser is not local', () => {
    const actions = machineActions(
      input({ guard: { allowed: false, reasons: ['client-not-loopback'] } })
    );
    expect(actions.restart.reason).toBe('guard');
    expect(actions.installService.reason).toBe('guard');
    expect(actions.uninstallService.reason).toBe('guard');
  });

  it('will not restart a foreground hub, nor a Windows task from inside itself', () => {
    expect(machineActions(input({ launch: 'foreground' })).restart.reason).toBe('foreground');
    expect(machineActions(input({ launch: 'service', platform: 'win32' })).restart.reason).toBe(
      'windows-service'
    );
    expect(machineActions(input({ launch: 'service' })).restart.available).toBe(true);
  });

  it('flips install and uninstall on whether a unit exists', () => {
    const installed = machineActions(input({ service: { ...SERVICE, installed: true } }));
    expect(installed.installService.reason).toBe('already-installed');
    expect(installed.uninstallService.available).toBe(true);
  });

  it('refuses to install a unit that could not find the auth secret', () => {
    expect(machineActions(input({ secretPersisted: false })).installService.reason).toBe(
      'secret-not-persisted'
    );
  });

  it('names an unsupported or unreadable supervisor rather than guessing', () => {
    expect(
      machineActions(input({ service: { ...SERVICE, platform: 'unsupported' } })).installService
        .reason
    ).toBe('unsupported-platform');
    expect(
      machineActions(input({ service: { ...SERVICE, error: 'no session bus' } })).uninstallService
        .reason
    ).toBe('service-unreadable');
  });
});

describe('evaluateMachineActionGuard', () => {
  it('asks the local-surface questions and not the install switch', () => {
    expect(
      evaluateMachineActionGuard({
        serverHost: '127.0.0.1',
        clientIp: '127.0.0.1',
        standalone: true,
        container: false,
      })
    ).toEqual({ allowed: true, reasons: [] });
    expect(
      evaluateMachineActionGuard({
        serverHost: '0.0.0.0',
        clientIp: '10.0.0.5',
        standalone: false,
        container: true,
      }).reasons
    ).toEqual(['container', 'server-not-loopback', 'client-not-loopback']);
  });
});
