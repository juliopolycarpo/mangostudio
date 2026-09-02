import { describe, expect, it } from 'bun:test';
import { HubProcessStatusSchema } from '@mangostudio/shared/machine';
import Value from 'typebox/value';
import type { ServerState } from '../../../../src/lib/server-state';
import {
  describeHubProcess,
  hubLaunchMode,
  hubUrl,
} from '../../../../src/modules/machine/domain/hub-process';

const STATE: ServerState = {
  pid: 42,
  port: 3001,
  host: '0.0.0.0',
  startedAt: 1_000,
  logFile: '/logs/server-1.log',
  version: '0.1.1',
  buildInfo: {
    gitSha: 'abc1234',
    gitDirty: false,
    builtAt: '2026-01-01T00:00:00Z',
    buildType: 'production',
  },
};

describe('hubLaunchMode', () => {
  it('distinguishes service, detached and foreground starts', () => {
    expect(hubLaunchMode({ logFile: '', service: 'mangostudio.service' })).toBe('service');
    expect(hubLaunchMode({ logFile: '/x.log' })).toBe('detached');
    expect(hubLaunchMode({ logFile: '' })).toBe('foreground');
  });
});

describe('hubUrl', () => {
  it('maps bind-all hosts to localhost and brackets IPv6', () => {
    expect(hubUrl('0.0.0.0', 3001)).toBe('http://localhost:3001');
    expect(hubUrl('::', 3001)).toBe('http://localhost:3001');
    expect(hubUrl('::1', 3001)).toBe('http://[::1]:3001');
    expect(hubUrl('127.0.0.1', 80)).toBe('http://127.0.0.1:80');
  });
});

describe('describeHubProcess', () => {
  it('describes nothing but running=false for a dead or absent state', () => {
    expect(describeHubProcess({ state: null, alive: false, now: 0 })).toEqual({ running: false });
    expect(describeHubProcess({ state: STATE, alive: false, now: 0 })).toEqual({ running: false });
  });

  it('describes a live state in the shared shape', () => {
    const status = describeHubProcess({ state: STATE, alive: true, now: 6_000, health: 'ok' });
    expect(Value.Check(HubProcessStatusSchema, status)).toBe(true);
    expect(status).toEqual({
      running: true,
      pid: 42,
      port: 3001,
      host: '0.0.0.0',
      url: 'http://localhost:3001',
      startedAt: 1_000,
      uptimeMs: 5_000,
      logFile: '/logs/server-1.log',
      version: '0.1.1',
      buildSha: 'abc1234',
      buildType: 'production',
      builtAt: '2026-01-01T00:00:00Z',
      health: 'ok',
      launch: 'detached',
    });
  });

  it('never reports a negative uptime from a clock that went backwards', () => {
    expect(describeHubProcess({ state: STATE, alive: true, now: 0 }).uptimeMs).toBe(0);
  });
});
