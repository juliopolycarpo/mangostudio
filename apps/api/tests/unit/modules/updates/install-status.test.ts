import { describe, expect, it } from 'bun:test';
import {
  resolveInstallStatus,
  upgradeRefusalReason,
} from '../../../../src/modules/updates/application/install-status';
import type { InstallOriginProbe } from '../../../../src/modules/updates/domain/install-origin';

function probe(overrides: Partial<InstallOriginProbe> = {}): InstallOriginProbe {
  return {
    platform: 'linux',
    env: {},
    execPath: '/home/j/.mango/dist/0.1.1/mangostudio',
    version: '0.1.1',
    standalone: true,
    container: false,
    home: '/home/j',
    readFile: () => null,
    ...overrides,
  };
}

describe('resolveInstallStatus', () => {
  it('uses the build’s own channel when none is configured', () => {
    const status = resolveInstallStatus(probe(), null, '0.1.1');

    expect(status.channel).toBe('stable');
    expect(status.installedVia.manager).toBe('self-managed');
    expect(status.plan.kind).toBe('self');
    expect(status.command).toBe('mangostudio upgrade');
  });

  it('lets a configured channel override the build’s own', () => {
    const status = resolveInstallStatus(probe(), 'canary', '0.1.1');

    expect(status.channel).toBe('canary');
    expect(status.command).toBe('mangostudio upgrade --canary');
  });

  it('delegates to the owning package manager', () => {
    const status = resolveInstallStatus(
      probe({ execPath: '/home/j/.bun/install/global/node_modules/mangostudio/bin/mangostudio' }),
      null,
      '0.1.1'
    );

    expect(status.installedVia.manager).toBe('bun');
    expect(status.plan.kind).toBe('delegate');
    expect(status.command).toBe('bun add -g mangostudio@latest');
  });
});

describe('upgradeRefusalReason', () => {
  it('is undefined for a self plan', () => {
    expect(upgradeRefusalReason({ kind: 'self' })).toBeUndefined();
  });

  it('is package-manager for a delegate plan', () => {
    expect(
      upgradeRefusalReason({
        kind: 'delegate',
        command: 'npm install -g mangostudio@latest',
        argv: [],
      })
    ).toBe('package-manager');
  });

  it('is the refusal’s own reason for a refused plan', () => {
    expect(
      upgradeRefusalReason({
        kind: 'refused',
        reason: 'source-checkout',
        command: 'git pull && bun run build',
        message: 'rebuild instead',
      })
    ).toBe('source-checkout');
  });
});
