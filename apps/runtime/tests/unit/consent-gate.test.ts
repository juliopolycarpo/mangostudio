import { describe, expect, it } from 'bun:test';
import { RemoteError } from '@mangostudio/protocol';
import {
  CONSENT_DENIED_KIND,
  RUNTIME_CONTRACT,
  type RuntimeMethod,
} from '@mangostudio/shared/runtime-contract';
import { RUNTIME_CONSENT_PRESETS } from '@mangostudio/shared/runtime-home';
import { gateHandlers } from '../../src/consent-gate';
import { staticConsentSource } from '../../src/consent-source';
import type { RuntimeHandlers } from '../../src/handlers';
import { createRuntimeMethodHandlers } from '../../src/registry';
import { FakeRuntimeHandlers } from '../support/fake-runtime-handlers';

/** The contract's own table, read by name — which is how a dispatch reaches it. */
const capabilities = Object.fromEntries(
  Object.entries(RUNTIME_CONTRACT.definition.methods).map(([method, entry]) => [
    method,
    entry.capabilities,
  ])
) as Readonly<Record<string, readonly string[] | undefined>>;

function call(map: RuntimeHandlers, method: RuntimeMethod): Promise<unknown> {
  const handle = map[method] as (params: unknown, context: { signal: AbortSignal }) => unknown;
  return Promise.resolve(handle({}, { signal: new AbortController().signal }));
}

describe('the contract capability table', () => {
  it('governs every method the registry actually registers', async () => {
    // `ContractHandlers` makes a missing handler a compile error, so this
    // guards the other direction: a handler registered under a name the
    // contract does not declare would reach a hub ungoverned.
    const registry = createRuntimeMethodHandlers({
      runtimeVersion: '0.0.0-test',
      emit: () => true,
    });
    try {
      for (const method of Object.keys(registry.handlers)) {
        expect(capabilities[method]).toBeDefined();
      }
    } finally {
      await registry.close();
    }
  });

  it('splits gh so a read-only machine cannot open a pull request', () => {
    // The gate reads the method name and never the params, so this split is the
    // only place the read/write line can be drawn for gh. `readonly` grants
    // `git` and refuses `shell`; if the mutating half rode plain `['git']` it
    // would run on a machine whose owner said no writes.
    expect(capabilities['gh.exec']).toEqual(['git']);
    expect(capabilities['gh.mutate']).toEqual(['git', 'shell']);
    expect(RUNTIME_CONSENT_PRESETS.readonly.git).toBe(true);
    expect(RUNTIME_CONSENT_PRESETS.readonly.shell).toBe(false);
  });

  it('puts every terminal leg behind shell, reads included', () => {
    // A `readonly` machine refuses `shell`, and an interactive PTY is broader
    // than any single command. Listing and attaching are gated too: there is
    // nothing to list on a machine that could never have opened one.
    for (const method of [
      'terminal.open',
      'terminal.attach',
      'terminal.detach',
      'terminal.write',
      'terminal.resize',
      'terminal.ack',
      'terminal.close',
      'terminal.list',
    ]) {
      expect(capabilities[method]).toEqual(['shell']);
    }
  });

  it('requires a write capability for everything that writes', () => {
    // `readonly` grants `library` and refuses `fsWrite`, so a library method
    // that touches files has to name both — listing only `library` would let
    // the profile whose whole promise is "no writes" write.
    for (const method of ['library.apply', 'library.remove', 'library.undo', 'snapshot.revert']) {
      expect(capabilities[method]).toContain('fsWrite');
    }
  });
});

describe('gateHandlers consent', () => {
  const gate = (allow: (typeof RUNTIME_CONSENT_PRESETS)['full'], slot: 'host' | 'wsl' | 'remote') =>
    gateHandlers(new FakeRuntimeHandlers().map, {
      consent: staticConsentSource(allow, slot),
      isUpdateActive: () => false,
    });

  it('lets every method through when everything is granted', async () => {
    const gated = gate(RUNTIME_CONSENT_PRESETS.full, 'host');

    expect(await call(gated, 'fs.read-file')).toEqual({ ok: true });
    expect(await call(gated, 'shell.run')).toEqual({ ok: true });
  });

  it('refuses a denied method instead of dropping it from the map', async () => {
    const gated = gate(RUNTIME_CONSENT_PRESETS.readonly, 'remote');

    // Still registered: an absent method answers METHOD_UNSUPPORTED, which is
    // what an older runtime says, and a hub cannot act on that.
    expect(gated['shell.run']).toBeDefined();
    expect(await call(gated, 'fs.read-file')).toEqual({ ok: true });
    await expect(call(gated, 'shell.run')).rejects.toThrow(/has not granted shell/);
  });

  it('names the capability, the slot, and the command that grants it', async () => {
    const gated = gate(RUNTIME_CONSENT_PRESETS.readonly, 'wsl');

    const error = await call(gated, 'shell.run').catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(RemoteError);
    expect((error as RemoteError).code).toBe('DENIED');
    expect((error as RemoteError).message).toContain('setup --slot wsl');
    expect((error as RemoteError).details).toMatchObject({
      kind: CONSENT_DENIED_KIND,
      method: 'shell.run',
      missing: ['shell'],
      capability: 'shell',
    });
  });

  it('refuses a method whose second capability is missing', async () => {
    // `readonly` grants library and refuses fsWrite: a read passes, an apply
    // does not.
    const gated = gate(RUNTIME_CONSENT_PRESETS.readonly, 'host');

    expect(await call(gated, 'library.scan')).toEqual({ ok: true });
    await expect(call(gated, 'library.apply')).rejects.toThrow(/has not granted fsWrite/);
  });

  it('refuses everything but health under the none profile', async () => {
    const gated = gate(RUNTIME_CONSENT_PRESETS.none, 'remote');

    for (const method of [
      'fs.read-file',
      'shell.run',
      'library.scan',
      'probing.runtimes',
    ] as const) {
      await expect(call(gated, method)).rejects.toThrow(/is refused/);
    }
    // Health answers under every profile; it is the one method with no
    // capability, and a machine that cannot be asked how it is is a machine
    // nobody can diagnose.
    expect(await call(gated, 'runtime.health')).toEqual({ ok: true });
  });

  it('re-reads consent on every call so a mid-connection setup takes effect', async () => {
    let allow = { ...RUNTIME_CONSENT_PRESETS.full };
    const gated = gateHandlers(new FakeRuntimeHandlers().map, {
      consent: { slot: 'host', current: () => allow, refresh: async () => allow },
      isUpdateActive: () => false,
    });

    expect(await call(gated, 'shell.run')).toEqual({ ok: true });
    allow = { ...allow, shell: false };
    await expect(call(gated, 'shell.run')).rejects.toThrow(/has not granted shell/);
  });
});
