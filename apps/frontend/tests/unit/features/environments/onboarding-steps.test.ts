/**
 * Where re-entering the flow puts you.
 *
 * Resume is derived, not stored, so this is the whole of it: a decision table
 * over data that exists anyway. Getting it wrong is not a cosmetic bug —
 * landing on "install the runtime" for a machine that already has one is how a
 * user learns not to trust the flow.
 */

import type { RuntimeHealthReport } from '@mangostudio/shared/runtime-home';
import { describe, expect, it } from 'vitest';
import {
  deriveOnboardingStep,
  endStateOf,
  onboardingSteps,
} from '../../../../src/features/environments/onboarding/steps';

function health(overrides: Partial<RuntimeHealthReport> = {}): RuntimeHealthReport {
  return {
    schemaVersion: 1,
    slot: 'remote',
    source: 'provisioned',
    runtimeVersion: '1.0.0',
    version: '1.0.0',
    binaryPath: '/home/me/.mango/runtime/remote/current/mangostudio-runtime',
    digest: null,
    profile: 'full',
    allow: {
      fsRead: true,
      fsWrite: true,
      shell: true,
      git: true,
      mcp: true,
      probing: true,
      library: true,
      checkpoints: true,
      update: true,
    },
    setup: { state: 'recorded' },
    platform: 'linux',
    arch: 'x64',
    homeDir: '/home/me',
    shells: ['bash'],
    git: { available: true },
    lastError: null,
    ...overrides,
  } as RuntimeHealthReport;
}

describe('onboardingSteps', () => {
  it('gives the two end states different middles and the same ends', () => {
    const ssh = onboardingSteps('ssh');
    const paired = onboardingSteps('paired');

    expect(ssh).toContain('install');
    expect(ssh).not.toContain('provision');
    // A paired machine has no stored config to install against: its push,
    // consent, pairing and service are one run over a temporary channel.
    expect(paired).toContain('provision');
    expect(paired).not.toContain('install');
    expect(ssh[0]).toBe('reach');
    expect(paired[0]).toBe('reach');
    expect(ssh.at(-1)).toBe('done');
    expect(paired.at(-1)).toBe('done');
  });
});

describe('endStateOf', () => {
  it('reads the end state back off the row the flow created', () => {
    expect(endStateOf('websocket')).toBe('paired');
    expect(endStateOf('ssh')).toBe('ssh');
  });
});

describe('deriveOnboardingStep', () => {
  it('starts an ssh machine the hub has never spoken to at the install', () => {
    expect(
      deriveOnboardingStep({
        transportKind: 'ssh',
        connected: false,
        health: null,
        probed: false,
      })
    ).toBe('install');
  });

  it('sends an installed but unanswered ssh machine to permissions', () => {
    expect(
      deriveOnboardingStep({
        transportKind: 'ssh',
        connected: true,
        health: health({ setup: { state: 'pending' } as RuntimeHealthReport['setup'] }),
        probed: false,
      })
    ).toBe('permissions');
  });

  it('sends a consented ssh machine to tools, and a probed one past them', () => {
    expect(
      deriveOnboardingStep({
        transportKind: 'ssh',
        connected: true,
        health: health(),
        probed: false,
      })
    ).toBe('tools');
    expect(
      deriveOnboardingStep({
        transportKind: 'ssh',
        connected: true,
        health: health(),
        probed: true,
      })
    ).toBe('library');
  });

  it('restarts a paired machine that is not connected at the ssh form', () => {
    // The hub stores no ssh credentials for a machine it reaches over a
    // socket, so it cannot resume the middle of the flow without being handed
    // them again. Landing anywhere else would be a step that cannot run.
    expect(
      deriveOnboardingStep({
        transportKind: 'websocket',
        connected: false,
        health: health(),
        probed: true,
      })
    ).toBe('reach');
  });

  it('picks a connected paired machine up after its provisioning', () => {
    expect(
      deriveOnboardingStep({
        transportKind: 'websocket',
        connected: true,
        health: health(),
        probed: false,
      })
    ).toBe('tools');
  });
});
