import { describe, expect, it } from 'bun:test';
import {
  planUpgrade,
  upgradeCommandFor,
  versionRoot,
} from '../../../../src/modules/updates/domain/upgrade-plan';

const linux = { platform: 'linux' as const, currentVersion: '0.1.1' };
const windows = { platform: 'win32' as const, currentVersion: '0.1.1' };

describe('planUpgrade', () => {
  it('lets a self-managed install upgrade itself on every channel', () => {
    expect(planUpgrade('self-managed', { channel: 'stable' }, linux)).toEqual({ kind: 'self' });
    expect(planUpgrade('self-managed', { channel: 'canary', sha: 'abc1234' }, linux)).toEqual({
      kind: 'self',
    });
  });

  it('spells the npm family by manager and channel', () => {
    expect(planUpgrade('bun', { channel: 'stable' }, linux)).toMatchObject({
      kind: 'delegate',
      command: 'bun add -g mangostudio@latest',
    });
    expect(planUpgrade('pnpm', { channel: 'canary' }, linux)).toMatchObject({
      command: 'pnpm add -g mangostudio@canary',
    });
    expect(
      planUpgrade(
        'npm',
        { channel: 'canary', sha: 'abc1234', version: '0.1.2-canary.abc1234' },
        linux
      )
    ).toMatchObject({ argv: ['npm', 'install', '-g', 'mangostudio@0.1.2-canary.abc1234'] });
  });

  it('refuses canary for Homebrew and Scoop and names the shell installer', () => {
    const brew = planUpgrade('homebrew', { channel: 'canary' }, linux);
    expect(brew).toMatchObject({ kind: 'refused', reason: 'channel-unsupported' });
    expect(brew.kind === 'refused' && brew.command).toContain('install.sh | bash -s -- --canary');
    expect(planUpgrade('homebrew', { channel: 'stable' }, linux)).toMatchObject({
      command: 'brew upgrade mangostudio',
    });

    const scoop = planUpgrade('scoop', { channel: 'canary' }, windows);
    expect(scoop.kind === 'refused' && scoop.command).toContain('install.ps1))) -Canary');
    expect(planUpgrade('scoop', { channel: 'stable' }, windows)).toMatchObject({
      command: 'scoop update mangostudio',
    });
  });

  it('gives cargo the rolling canary crate but never a pinned commit', () => {
    expect(planUpgrade('cargo', { channel: 'canary' }, linux)).toMatchObject({
      command: 'cargo install mangostudio --version 0.1.1-canary --locked',
    });
    expect(planUpgrade('cargo', { channel: 'canary', sha: 'abc1234' }, linux)).toMatchObject({
      kind: 'refused',
      reason: 'channel-unsupported',
    });
  });

  it('turns docker and source into the command that replaces them', () => {
    expect(planUpgrade('docker', { channel: 'canary', sha: 'abc1234' }, linux)).toMatchObject({
      kind: 'refused',
      reason: 'container',
      command: 'docker pull ghcr.io/juliopolycarpo/mangostudio:0.1.1-canary.abc1234',
    });
    expect(planUpgrade('docker', { channel: 'stable', version: '0.1.2' }, linux)).toMatchObject({
      command: 'docker pull ghcr.io/juliopolycarpo/mangostudio:0.1.2',
    });
    expect(planUpgrade('source', { channel: 'stable' }, linux)).toMatchObject({
      reason: 'source-checkout',
      command: 'git pull && bun run build',
    });
  });

  it('refuses an unknown origin with the installer for the platform', () => {
    const plan = planUpgrade('unknown', { channel: 'stable' }, windows);
    expect(plan).toMatchObject({ kind: 'refused', reason: 'unknown-origin' });
    expect(plan.kind === 'refused' && plan.command).toContain('irm https://github.com/');
  });
});

describe('upgradeCommandFor', () => {
  it('names the hub command for self-managed installs and the plan command otherwise', () => {
    expect(upgradeCommandFor({ kind: 'self' }, 'stable')).toBe('mangostudio upgrade');
    expect(upgradeCommandFor({ kind: 'self' }, 'canary')).toBe('mangostudio upgrade --canary');
    expect(upgradeCommandFor(planUpgrade('bun', { channel: 'stable' }, linux), 'stable')).toBe(
      'bun add -g mangostudio@latest'
    );
  });
});

describe('versionRoot', () => {
  it('strips the prerelease', () => {
    expect(versionRoot('0.1.1-canary.abc1234')).toBe('0.1.1');
    expect(versionRoot('0.1.1')).toBe('0.1.1');
  });
});
