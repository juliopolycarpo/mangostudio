import { describe, expect, it } from 'bun:test';
import type { RuntimeHealthReport } from '@mangostudio/shared/runtime-home';
import {
  buildRuntimeLifecycleView,
  lifecycleActions,
} from '../../../../src/modules/environments/domain/runtime-lifecycle-view';

const health = (overrides: Partial<RuntimeHealthReport> = {}): RuntimeHealthReport => ({
  schemaVersion: 1,
  slot: 'wsl',
  source: 'provisioned',
  runtimeVersion: '1.2.3',
  version: '1.2.3',
  binaryPath: '/home/u/.mango/runtime/wsl/current/mangostudio-runtime',
  digest: 'sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
  profile: 'full',
  allow: {
    git: true,
    probing: true,
    mcp: true,
    library: true,
    checkpoints: true,
    fsRead: true,
    fsWrite: true,
    shell: true,
    update: true,
  },
  setup: { state: 'configured', at: '2026-01-01T00:00:00.000Z', by: 'cli' },
  platform: 'linux',
  arch: 'x64',
  homeDir: '/home/u',
  shells: ['bash'],
  git: { available: true, version: '2.47.0' },
  lastError: null,
  ...overrides,
});

describe('lifecycleActions', () => {
  it('gives WSL install/reinstall/upgrade and SSH those plus setup', () => {
    expect(lifecycleActions('wsl')).toEqual(['install', 'reinstall', 'upgrade']);
    expect(lifecycleActions('ssh')).toEqual(['install', 'reinstall', 'upgrade', 'setup']);
  });

  it('gives dial-in and local transports an empty action list', () => {
    expect(lifecycleActions('websocket')).toEqual([]);
    expect(lifecycleActions('http')).toEqual([]);
    expect(lifecycleActions('in-process')).toEqual([]);
    expect(lifecycleActions('stdio')).toEqual([]);
  });
});

describe('buildRuntimeLifecycleView', () => {
  it('marks disconnected health as stale and keeps the payload', () => {
    const view = buildRuntimeLifecycleView({
      transportKind: 'wsl',
      health: health(),
      readAtMs: 1_000,
      connected: false,
      nowMs: 2_000,
    });
    expect(view.stale).toBe(true);
    expect(view.health?.version).toBe('1.2.3');
    expect(view.actions).toEqual(['install', 'reinstall', 'upgrade']);
  });

  it('marks connected fresh health as not stale', () => {
    const view = buildRuntimeLifecycleView({
      transportKind: 'ssh',
      health: health({ slot: 'remote' }),
      readAtMs: 10_000,
      connected: true,
      nowMs: 11_000,
    });
    expect(view.stale).toBe(false);
    expect(view.actions).toContain('setup');
  });

  it('attaches manualCommands for websocket and http only', () => {
    const ws = buildRuntimeLifecycleView({
      transportKind: 'websocket',
      health: null,
      readAtMs: null,
      connected: false,
      nowMs: 1,
    });
    expect(ws.actions).toEqual([]);
    expect(ws.manualCommands?.setup).toContain('setup --slot remote');

    const wsl = buildRuntimeLifecycleView({
      transportKind: 'wsl',
      health: null,
      readAtMs: null,
      connected: false,
      nowMs: 1,
    });
    expect(wsl.manualCommands).toBeUndefined();
  });
});
