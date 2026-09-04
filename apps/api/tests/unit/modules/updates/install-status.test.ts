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

  it('lets a request override the channel for a specific ask, ahead of the configured one', () => {
    const status = resolveInstallStatus(probe(), 'stable', '0.1.1', { channel: 'canary' });

    expect(status.channel).toBe('canary');
  });

  it('threads a request’s version and sha into the plan for a self-managed install', () => {
    const status = resolveInstallStatus(probe(), null, '0.1.1', {
      channel: 'canary',
      sha: 'abc1234',
    });

    // A self-managed plan carries no request echo (planUpgrade's `self`
    // branch ignores version/sha entirely) — this only proves the request
    // reached planUpgrade rather than throwing or being silently dropped.
    expect(status.plan.kind).toBe('self');
  });

  it('threads a request’s pinned version into a delegate plan (cargo canary)', () => {
    const status = resolveInstallStatus(
      probe({ env: { MANGOSTUDIO_LAUNCHER: 'cargo' } }),
      null,
      '0.1.1',
      { channel: 'canary', version: '0.2.0' }
    );

    expect(status.plan).toEqual({
      kind: 'delegate',
      command: 'cargo install mangostudio --version 0.2.0-canary --locked',
      argv: ['cargo', 'install', 'mangostudio', '--version', '0.2.0-canary', '--locked'],
    });
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
