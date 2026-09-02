import { describe, expect, it } from 'bun:test';
import Value from 'typebox/value';
import {
  HubProcessStatusSchema,
  MachineLogTailSchema,
  type MachineStatus,
  MachineStatusSchema,
} from '../../src/machine';

const STATUS: MachineStatus = {
  hub: {
    running: true,
    pid: 42,
    port: 3001,
    host: '127.0.0.1',
    url: 'http://127.0.0.1:3001',
    startedAt: 1_700_000_000_000,
    uptimeMs: 5_000,
    logFile: '/home/j/.mango/logs/service.log',
    version: '0.1.1',
    buildSha: 'abc1234',
    health: 'ok',
    launch: 'service',
    serviceUnit: 'mangostudio.service',
  },
  service: {
    schemaVersion: 1,
    platform: 'linux',
    unitName: 'mangostudio.service',
    installed: true,
    enabled: true,
    running: true,
    linger: true,
  },
  runtimeBinary: {
    path: '/home/j/.mango/dist/current/mangostudio-runtime',
    present: true,
    version: '0.1.1',
    versionMatches: true,
    error: null,
  },
  hostSlot: {
    present: false,
    profile: 'full',
    directory: '/home/j/.mango/runtime/host',
    error: null,
  },
  platform: 'linux',
  standalone: true,
  container: false,
  homeDir: '/home/j/.mango',
  logsDir: '/home/j/.mango/logs',
  configFile: '/home/j/.mango/config.toml',
  actions: {
    guard: { allowed: true, reasons: [] },
    restart: { available: true, command: 'mangostudio restart' },
    installService: {
      available: false,
      command: 'mangostudio service install',
      reason: 'installed',
    },
    uninstallService: { available: true, command: 'mangostudio service uninstall' },
  },
};

describe('machine contract', () => {
  it('accepts a full status document', () => {
    expect(Value.Check(MachineStatusSchema, STATUS)).toBe(true);
  });

  it('accepts a hub that is not running with nothing else attached', () => {
    expect(Value.Check(HubProcessStatusSchema, { running: false })).toBe(true);
  });

  it('rejects a launch mode it does not know', () => {
    expect(Value.Check(HubProcessStatusSchema, { running: true, launch: 'cron' })).toBe(false);
  });

  it('rejects a service action outside install and uninstall', () => {
    expect(
      Value.Check(MachineStatusSchema, {
        ...STATUS,
        actions: { ...STATUS.actions, guard: { allowed: false, reasons: ['bogus'] } },
      })
    ).toBe(false);
  });

  it('describes a log tail with or without a file', () => {
    expect(Value.Check(MachineLogTailSchema, { file: null, lines: [], truncated: false })).toBe(
      true
    );
    expect(
      Value.Check(MachineLogTailSchema, { file: '/x.log', lines: ['a', 'b'], truncated: true })
    ).toBe(true);
  });
});
