import { describe, expect, it } from 'bun:test';
import { en } from '@mangostudio/shared/i18n';
import type { MachineStatus } from '@mangostudio/shared/machine';
import {
  actionRefusalLines,
  machineGuardReasonLabel,
} from '../../../../src/features/environments/machine/format';

function withActions(actions: MachineStatus['actions']): Pick<MachineStatus, 'actions'> {
  return { actions };
}

describe('actionRefusalLines', () => {
  it('says nothing for an available action', () => {
    expect(
      actionRefusalLines(
        en,
        withActions({
          guard: { allowed: true, reasons: [] },
          restart: { available: true, command: 'mangostudio restart' },
          installService: { available: true, command: 'x' },
          uninstallService: { available: true, command: 'x' },
        }),
        'restart'
      )
    ).toEqual([]);
  });

  it('spells out every guard reason, in the machine wording where one exists', () => {
    const lines = actionRefusalLines(
      en,
      withActions({
        guard: { allowed: false, reasons: ['container', 'disabled'] },
        restart: { available: false, command: 'mangostudio restart', reason: 'guard' },
        installService: { available: true, command: 'x' },
        uninstallService: { available: true, command: 'x' },
      }),
      'restart'
    );
    expect(lines).toEqual([
      en.environments.machine.actions.guard.container,
      en.environments.install.guardBlocked.disabled,
    ]);
  });

  it("uses the action's own reason when the guard passed", () => {
    const lines = actionRefusalLines(
      en,
      withActions({
        guard: { allowed: true, reasons: [] },
        restart: { available: false, command: 'mangostudio restart', reason: 'foreground' },
        installService: { available: true, command: 'x' },
        uninstallService: { available: true, command: 'x' },
      }),
      'restart'
    );
    expect(lines).toEqual([en.environments.machine.actions.reasons.foreground]);
  });
});

describe('machineGuardReasonLabel', () => {
  it('falls back to the install wording for a reason without a machine sentence', () => {
    expect(machineGuardReasonLabel(en, 'runtime-denied')).toBe(
      en.environments.install.guardBlocked['runtime-denied']
    );
  });
});
