import { describe, expect, it } from 'bun:test';
import {
  type ExternalAgentConfiguration,
  type ExternalAgentRuntimeDescriptor,
  NO_EXTERNAL_AGENT_CAPABILITIES,
} from '@mangostudio/shared/external-agents';
import type { RuntimeClient } from '../../../src/services/runtime-client/runtime-client';
import { createFakeExternalRuntime } from '../../support/external-agents/fake-external-runtime';
import {
  createRustTurnHarness,
  insertCursorChat,
  openRustSmokeHub,
  type RustTurnHarnessOptions,
  runRustAgentSmoke,
  rustSmokeConfiguration,
  rustSmokeRuntimeEnv,
} from '../../support/external-agents/rust-agent-turns';
import { insertTestUser } from '../../support/factories';

class FakeSmokePeer {
  terminationCount = 0;

  terminate() {
    this.terminationCount += 1;
    return Promise.resolve({ code: 0, signal: null });
  }
}

class FakeSmokeHub {
  closeCount = 0;

  close() {
    this.closeCount += 1;
  }
}

class FakeSmokeConnection {
  readonly hub = new FakeSmokeHub();

  constructor(private readonly failure?: Error) {}

  readonly connect = () => {
    if (this.failure) return Promise.reject(this.failure);
    return Promise.resolve(this.hub);
  };
}

class FakeSmokeTurns {
  closeCount = 0;

  close() {
    this.closeCount += 1;
    return Promise.resolve();
  }

  readonly succeed = () => Promise.resolve('pong');
  readonly fail = () => Promise.reject(new Error('controlled turn assertion failed'));
}

function controlledTurnRefusal(): Error {
  return new Error('controlled vendor refusal');
}

async function configurationFixture(configuration?: ExternalAgentConfiguration) {
  const runtime = createFakeExternalRuntime({ turnFailure: controlledTurnRefusal });
  const owner = await insertTestUser();
  const chatId = await insertCursorChat(owner.id, 'local', '/work/smoke');
  const options: RustTurnHarnessOptions = {
    client: runtime.client,
    userId: owner.id,
    chatId,
    workspace: '/work/smoke',
    credentialHomeFingerprint: credentialHomeOf(runtime.client),
    ...(configuration ? { configuration } : {}),
  };
  const turns = createRustTurnHarness(options);
  expect(turns.effectiveConfiguration()).toBeUndefined();
  await runRustAgentSmoke(turns, () => turns.start('Reply pong. Do not use tools.'));
  expect(turns.effectiveConfiguration()).toEqual(runtime.calls.open[0]?.configuration);
  expect(turns.liveSessionCount()).toBe(0);
  return runtime.calls;
}

function credentialHomeOf(client: RuntimeClient): string {
  const fingerprint = client.manifest.identityIsolation?.credentialHomeFingerprint;
  if (!fingerprint) throw new Error('Expected the named fake runtime to attest a credential home');
  return fingerprint;
}

function smokeDescriptor(
  overrides: Partial<ExternalAgentRuntimeDescriptor> = {}
): ExternalAgentRuntimeDescriptor {
  return {
    targetId: 'codex',
    installed: true,
    authState: 'signed-in',
    capabilities: NO_EXTERNAL_AGENT_CAPABILITIES,
    supportedConfigurations: [
      { level: 'read-only', routing: 'user', supported: true, unattended: false },
    ],
    models: [
      { id: 'hidden-default', hidden: true, isDefault: true },
      { id: 'first-visible' },
      { id: 'visible-default', isDefault: true },
    ],
    ...overrides,
  };
}

describe('Rust live smoke ownership', () => {
  it('registers and terminates the peer even when the handshake rejects', async () => {
    const peer = new FakeSmokePeer();
    const connection = new FakeSmokeConnection(new Error('controlled handshake rejection'));
    const cleanups: Array<() => Promise<void>> = [];

    await expect(
      openRustSmokeHub(peer, connection.connect, (cleanup) => cleanups.push(cleanup))
    ).rejects.toThrow('controlled handshake rejection');

    expect(cleanups).toHaveLength(1);
    await cleanups[0]?.();
    expect(peer.terminationCount).toBe(1);
    expect(connection.hub.closeCount).toBe(0);
  });

  it('closes a connected hub and its peer through one cleanup owner', async () => {
    const peer = new FakeSmokePeer();
    const connection = new FakeSmokeConnection();
    const cleanups: Array<() => Promise<void>> = [];

    expect(
      await openRustSmokeHub(peer, connection.connect, (cleanup) => cleanups.push(cleanup))
    ).toBe(connection.hub);
    expect(cleanups).toHaveLength(1);
    expect(peer.terminationCount).toBe(0);
    await cleanups[0]?.();
    expect(peer.terminationCount).toBe(1);
    expect(connection.hub.closeCount).toBe(1);
  });

  it('closes the chat session when a smoke assertion rejects', async () => {
    const turns = new FakeSmokeTurns();
    await expect(runRustAgentSmoke(turns, turns.fail)).rejects.toThrow(
      'controlled turn assertion failed'
    );
    expect(turns.closeCount).toBe(1);
  });

  it('returns the successful smoke result and closes its session once', async () => {
    const turns = new FakeSmokeTurns();
    expect(await runRustAgentSmoke(turns, turns.succeed)).toBe('pong');
    expect(turns.closeCount).toBe(1);
  });
});

describe('Rust live smoke configuration', () => {
  it('chooses the advertised visible default model and supported ReadOnly/User pair', () => {
    expect(rustSmokeConfiguration(smokeDescriptor())).toEqual({
      model: 'visible-default',
      level: 'read-only',
      routing: 'user',
      workspaceRoots: [],
    });
  });

  it('uses the first visible model when the default is hidden', () => {
    expect(
      rustSmokeConfiguration(
        smokeDescriptor({
          models: [{ id: 'hidden', hidden: true, isDefault: true }, { id: 'safe' }],
        })
      ).model
    ).toBe('safe');
  });

  it('refuses an unsupported permission pair before opening a vendor', () => {
    expect(() =>
      rustSmokeConfiguration(
        smokeDescriptor({
          supportedConfigurations: [
            { level: 'read-only', routing: 'user', supported: false, unattended: false },
          ],
        })
      )
    ).toThrow('expected codex to advertise supported ReadOnly/User');
  });

  it('refuses an unadvertised Codex model while allowing an uncatalogued Cursor default', () => {
    expect(() => rustSmokeConfiguration(smokeDescriptor({ models: [] }))).toThrow(
      'expected codex to advertise a visible smoke model | received: []'
    );
    expect(
      rustSmokeConfiguration(smokeDescriptor({ targetId: 'cursor', models: undefined }))
    ).toEqual({ level: 'read-only', routing: 'user', workspaceRoots: [] });
  });
  it('forwards the selected model and ReadOnly/User pair to both open and turn', async () => {
    const configuration: ExternalAgentConfiguration = {
      model: 'advertised-smoke-model',
      level: 'read-only',
      routing: 'user',
      workspaceRoots: ['/work/smoke'],
    };
    const calls = await configurationFixture(configuration);
    expect(calls.open[0]?.configuration).toEqual(configuration);
    expect(calls.turn[0]?.configuration).toEqual(configuration);
    expect(calls.respond).toHaveLength(0);
    expect(calls.close).toHaveLength(1);
  });

  it('keeps fixture qualification defaults when no configuration was selected', async () => {
    const calls = await configurationFixture();
    const configuration: ExternalAgentConfiguration = {
      level: 'default',
      routing: 'user',
      workspaceRoots: [],
    };
    expect(calls.open[0]?.configuration).toEqual(configuration);
    expect(calls.turn[0]?.configuration).toEqual(configuration);
    expect(calls.close).toHaveLength(1);
  });

  it('restores credentials only to the sanitized runtime child environment', () => {
    const source = {
      HOME: '/tmp/mangostudio-test-home-controlled',
      USERPROFILE: '/tmp/mangostudio-test-home-controlled',
      MANGOSTUDIO_REAL_HOME: '/home/live-smoke-owner',
      PATH: '/pinned/vendors:/usr/bin',
      API_KEY: 'redaction-canary',
    };
    expect(rustSmokeRuntimeEnv(source, '/tmp/live-smoke-mango')).toEqual({
      HOME: '/home/live-smoke-owner',
      USERPROFILE: '/home/live-smoke-owner',
      PATH: '/pinned/vendors:/usr/bin',
      MANGO_HOME: '/tmp/live-smoke-mango',
    });
    expect(source.HOME).toBe('/tmp/mangostudio-test-home-controlled');
  });

  it('retains the supplied home when no original credential home was recorded', () => {
    expect(rustSmokeRuntimeEnv({ HOME: '/tmp/fixture-home' }, '/tmp/mango')).toEqual({
      HOME: '/tmp/fixture-home',
      MANGO_HOME: '/tmp/mango',
    });
  });
});
