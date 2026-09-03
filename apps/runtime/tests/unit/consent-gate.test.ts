import { describe, expect, it } from 'bun:test';
import { RUNTIME_CONSENT_PRESETS } from '@mangostudio/shared/runtime-home';
import {
  CONSENT_DENIED_KIND,
  gateHandlersByConsent,
  RUNTIME_METHOD_CAPABILITIES,
} from '../../src/consent-gate';
import { staticConsentSource } from '../../src/consent-source';
import { RuntimeServiceError } from '../../src/errors';
import type { RuntimeMethodHandler } from '../../src/host';
import { createRuntimeMethodHandlers } from '../../src/registry';

const RAN = Symbol('ran');

/** The table read by name, which is how a registry key reaches it. */
const capabilities = RUNTIME_METHOD_CAPABILITIES as Readonly<
  Record<string, readonly string[] | undefined>
>;

function handlers(...methods: readonly string[]): ReadonlyMap<string, RuntimeMethodHandler> {
  return new Map(methods.map((method) => [method, async () => RAN]));
}

async function call(
  map: ReadonlyMap<string, RuntimeMethodHandler>,
  method: string
): Promise<unknown> {
  const handle = map.get(method);
  if (!handle) throw new Error(`${method} is not registered`);
  return await handle({}, { signal: AbortSignal.abort() } as never);
}

describe('RUNTIME_METHOD_CAPABILITIES', () => {
  it('governs every method the registry actually registers', async () => {
    // The table is keyed by `RuntimeMethod`, so tsc catches a method declared
    // in the protocol and forgotten here. It cannot catch a handler registered
    // under a name the protocol does not declare, which is the other way an
    // ungoverned method reaches a hub.
    const registry = createRuntimeMethodHandlers({
      runtimeVersion: '0.0.0-test',
      emit: () => undefined,
    });
    try {
      for (const method of registry.handlers.keys()) {
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

describe('gateHandlersByConsent', () => {
  it('lets every method through when everything is granted', async () => {
    const gated = gateHandlersByConsent(
      handlers('fs.read-file', 'shell.run'),
      staticConsentSource(RUNTIME_CONSENT_PRESETS.full, 'host')
    );
    expect(await call(gated, 'fs.read-file')).toBe(RAN);
    expect(await call(gated, 'shell.run')).toBe(RAN);
  });

  it('refuses a denied method instead of dropping it from the map', async () => {
    const gated = gateHandlersByConsent(
      handlers('fs.read-file', 'shell.run'),
      staticConsentSource(RUNTIME_CONSENT_PRESETS.readonly, 'remote')
    );

    // Still registered: an absent method answers METHOD_UNSUPPORTED, which is
    // what an older runtime says, and a hub cannot act on that.
    expect(gated.has('shell.run')).toBe(true);
    expect(await call(gated, 'fs.read-file')).toBe(RAN);
    await expect(call(gated, 'shell.run')).rejects.toThrow(/has not granted shell/);
  });

  it('names the capability, the slot, and the command that grants it', async () => {
    const gated = gateHandlersByConsent(
      handlers('shell.run'),
      staticConsentSource(RUNTIME_CONSENT_PRESETS.readonly, 'wsl')
    );

    const error = await call(gated, 'shell.run').catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(RuntimeServiceError);
    expect((error as RuntimeServiceError).kind).toBe(CONSENT_DENIED_KIND);
    expect((error as RuntimeServiceError).message).toContain('setup --slot wsl');
    expect((error as RuntimeServiceError).data).toMatchObject({
      method: 'shell.run',
      missing: ['shell'],
      capability: 'shell',
    });
  });

  it('refuses a method whose second capability is missing', async () => {
    // `readonly` grants library and refuses fsWrite: a read passes, an apply
    // does not.
    const gated = gateHandlersByConsent(
      handlers('library.scan', 'library.apply'),
      staticConsentSource(RUNTIME_CONSENT_PRESETS.readonly, 'host')
    );

    expect(await call(gated, 'library.scan')).toBe(RAN);
    await expect(call(gated, 'library.apply')).rejects.toThrow(/has not granted fsWrite/);
  });

  it('refuses everything under the none profile', async () => {
    const gated = gateHandlersByConsent(
      handlers('fs.read-file', 'shell.run', 'library.scan', 'probing.runtimes'),
      staticConsentSource(RUNTIME_CONSENT_PRESETS.none, 'remote')
    );

    for (const method of gated.keys()) {
      await expect(call(gated, method)).rejects.toThrow(/is refused/);
    }
  });

  it('refuses a method it has never heard of rather than waving it through', async () => {
    const gated = gateHandlersByConsent(
      handlers('something.new'),
      staticConsentSource(RUNTIME_CONSENT_PRESETS.readonly, 'host')
    );

    // Reached only if a handler is registered under a name the protocol does
    // not declare. Deciding that an unrecognised name must be harmless is how a
    // gate stops being one — and the refusal says that, rather than blaming a
    // capability that had nothing to do with it.
    await expect(call(gated, 'something.new')).rejects.toThrow(/no capability governs it/);
  });

  it('re-reads consent on every call so a mid-connection setup takes effect', async () => {
    let allow = { ...RUNTIME_CONSENT_PRESETS.full };
    const consent = {
      slot: 'host' as const,
      current: () => allow,
      refresh: async () => allow,
    };
    const gated = gateHandlersByConsent(handlers('shell.run'), consent);

    expect(await call(gated, 'shell.run')).toBe(RAN);
    allow = { ...allow, shell: false };
    await expect(call(gated, 'shell.run')).rejects.toThrow(/has not granted shell/);
  });
});
