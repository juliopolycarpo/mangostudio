import { describe, expect, it } from 'bun:test';
import Value from 'typebox/value';
import {
  MachineUpdateStatusSchema,
  MachineUpgradeBodySchema,
  UpgradeReportSchema,
  type UpgradeStreamEvent,
  UpgradeStreamEventSchema,
} from '../../src/updates';

describe('updates contract', () => {
  it('accepts a delegated package-manager status with no check yet', () => {
    expect(
      Value.Check(MachineUpdateStatusSchema, {
        installedVia: {
          manager: 'bun',
          channel: 'stable',
          executable:
            '/home/j/.bun/install/global/node_modules/@mangostudio/cli-linux-x64/mangostudio',
          launcherPath: '/home/j/.bun/install/global/node_modules/mangostudio/bin/mangostudio.js',
        },
        check: null,
        checksEnabled: true,
        canUpgrade: false,
        reason: 'package-manager',
        command: 'bun add -g mangostudio@latest',
      })
    ).toBe(true);
  });

  it('rejects a body that names a malformed sha or an unknown key', () => {
    expect(Value.Check(MachineUpgradeBodySchema, { channel: 'canary', sha: 'abc1234' })).toBe(true);
    expect(Value.Check(MachineUpgradeBodySchema, { sha: 'not-a-sha' })).toBe(false);
    expect(Value.Check(MachineUpgradeBodySchema, { force: true })).toBe(false);
  });

  it('types every stream event the engine emits', () => {
    const events: UpgradeStreamEvent[] = [
      {
        type: 'stage',
        stage: 'download',
        detail: 'mangostudio-0.1.2-linux-x64.tar.gz',
        done: false,
      },
      { type: 'output', stream: 'stdout', line: 'Installed MangoStudio 0.1.2', done: false },
      {
        type: 'done',
        done: true,
        outcome: 'upgraded',
        installedVia: { manager: 'self-managed', channel: 'stable', executable: '/x' },
        currentVersion: '0.1.1',
        restart: 'scheduled',
        exitCode: 0,
      },
      { type: 'error', error: 'boom', code: 'INTERNAL', done: true },
    ];
    for (const event of events) {
      expect(Value.Check(UpgradeStreamEventSchema, event)).toBe(true);
    }
    expect(Value.Check(UpgradeStreamEventSchema, { type: 'done', done: true, exitCode: 7 })).toBe(
      false
    );
  });

  it('accepts an "available" outcome for a --check preview with no download', () => {
    expect(
      Value.Check(UpgradeReportSchema, {
        outcome: 'available',
        installedVia: { manager: 'self-managed', channel: 'stable', executable: '/x' },
        currentVersion: '0.1.1',
        target: {
          channel: 'stable',
          version: '0.1.2',
          assetName: 'mangostudio-0.1.2-linux-x64.tar.gz',
          url: 'https://example.test/mangostudio-0.1.2-linux-x64.tar.gz',
          kind: 'archive',
          verification: 'sha256-sums',
        },
        exitCode: 0,
      })
    ).toBe(true);
  });
});
