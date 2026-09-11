import { describe, expect, it } from 'bun:test';
import { RemoteError } from '@mangostudio/protocol';
import { CONSENT_DENIED_KIND, type RuntimeMethod } from '@mangostudio/shared/runtime-contract';
import { RUNTIME_CONSENT_PRESETS } from '@mangostudio/shared/runtime-home';
import type { RuntimeAuditSink } from '../../src/audit-log';
import { gateHandlers, type RuntimeGateDeps } from '../../src/consent-gate';
import { staticConsentSource } from '../../src/consent-source';
import { PathAccessError } from '../../src/errors';
import { FakeRuntimeHandlers } from '../support/fake-runtime-handlers';

/** Collects audit lines in memory; the on-disk sink has its own suite. */
class FakeAuditSink implements RuntimeAuditSink {
  readonly enabled = true;
  readonly path = '<memory>';
  readonly records: Array<Parameters<RuntimeAuditSink['record']>[0]> = [];
  hub: { readonly host: string; readonly user: string } | null = null;

  lastError(): string | null {
    return null;
  }
  setHub(hub: { readonly host: string; readonly user: string } | null): void {
    this.hub = hub ?? null;
  }
  record(input: Parameters<RuntimeAuditSink['record']>[0]): void {
    this.records.push(input);
  }
  async flush(): Promise<void> {
    // Nothing is buffered; the records are already in memory.
  }
  async close(): Promise<void> {
    // Nothing to release.
  }
}

function call(
  handlers: ReturnType<typeof gateHandlers>,
  method: RuntimeMethod,
  params: unknown = {},
  signal: AbortSignal = new AbortController().signal
): Promise<unknown> {
  const handle = handlers[method] as (params: unknown, context: { signal: AbortSignal }) => unknown;
  return Promise.resolve(handle(params, { signal }));
}

function deps(overrides: Partial<RuntimeGateDeps> = {}): RuntimeGateDeps {
  return {
    consent: staticConsentSource(RUNTIME_CONSENT_PRESETS.full, 'host'),
    isUpdateActive: () => false,
    ...overrides,
  };
}

describe('gateHandlers dispatch', () => {
  it('answers DENIED and writes the audit line when consent refuses', async () => {
    const audit = new FakeAuditSink();
    const gated = gateHandlers(new FakeRuntimeHandlers().map, {
      ...deps({ consent: staticConsentSource(RUNTIME_CONSENT_PRESETS.readonly, 'wsl') }),
      audit,
    });

    const error = await call(gated, 'shell.run', { command: 'true' }).catch(
      (thrown: unknown) => thrown
    );

    expect(error).toBeInstanceOf(RemoteError);
    expect((error as RemoteError).code).toBe('DENIED');
    expect((error as RemoteError).details).toMatchObject({ kind: CONSENT_DENIED_KIND });
    // The refusal and its evidence share one dispatch path so they cannot drift.
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({
      method: 'shell.run',
      outcome: 'denied',
      capability: 'shell',
      code: 'DENIED',
    });
    expect(audit.records[0]?.params).toEqual({ command: 'true' });
  });

  it('records the granted call it let through', async () => {
    const audit = new FakeAuditSink();
    const gated = gateHandlers(new FakeRuntimeHandlers().map, { ...deps(), audit });

    await call(gated, 'fs.read-file', { path: '/tmp/a' });

    expect(audit.records).toMatchObject([{ method: 'fs.read-file', outcome: 'ok' }]);
    expect(audit.records[0]?.code).toBeUndefined();
  });

  it('refuses an update while an ordinary call is still in flight', async () => {
    const release = Promise.withResolvers<void>();
    const handlers = new FakeRuntimeHandlers({ 'fs.read-file': () => release.promise });
    const gated = gateHandlers(handlers.map, deps());

    const inFlight = call(gated, 'fs.read-file');
    const refusal = await call(gated, 'runtime.update.begin').catch((thrown: unknown) => thrown);

    expect(refusal).toBeInstanceOf(RemoteError);
    expect((refusal as RemoteError).code).toBe('RUNTIME_UPDATE_REFUSED');
    expect((refusal as RemoteError).details).toMatchObject({ reason: 'call_in_flight' });

    release.resolve();
    await inFlight;
  });

  it('refuses an ordinary call while an update is in progress', async () => {
    const gated = gateHandlers(new FakeRuntimeHandlers().map, deps({ isUpdateActive: () => true }));

    const refusal = await call(gated, 'fs.read-file').catch((thrown: unknown) => thrown);

    expect((refusal as RemoteError).code).toBe('RUNTIME_UPDATE_REFUSED');
    expect((refusal as RemoteError).details).toMatchObject({ reason: 'update_in_progress' });
  });

  it('refuses an ordinary call from the moment an update starts dispatching', async () => {
    // Not `isUpdateActive`: that flag only turns on once `runtime.update.begin`
    // has answered. The window this closes is the one before that — the update
    // has claimed its slot and is still running, and an ordinary call landing
    // there would overlap the bytes being rewritten.
    const release = Promise.withResolvers<void>();
    const handlers = new FakeRuntimeHandlers({ 'runtime.update.begin': () => release.promise });
    const gated = gateHandlers(handlers.map, deps({ isUpdateActive: () => false }));

    const begin = call(gated, 'runtime.update.begin');
    const refusal = await call(gated, 'fs.read-file').catch((thrown: unknown) => thrown);

    expect(refusal).toBeInstanceOf(RemoteError);
    expect((refusal as RemoteError).code).toBe('RUNTIME_UPDATE_REFUSED');
    expect((refusal as RemoteError).details).toMatchObject({ reason: 'update_in_progress' });

    release.resolve();
    await begin;
  });

  it('turns a service error into INTERNAL carrying its kind', async () => {
    // The class does not survive the wire; `details.kind` is what lets the hub
    // rebuild the right error instead of matching on message text.
    const handlers = new FakeRuntimeHandlers({
      'fs.read-file': () => {
        throw new PathAccessError('"/etc/shadow" is outside every allowed root.', {
          resolvedPath: '/etc/shadow',
        });
      },
    });
    const gated = gateHandlers(handlers.map, deps());

    const error = await call(gated, 'fs.read-file').catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(RemoteError);
    expect((error as RemoteError).code).toBe('INTERNAL');
    expect((error as RemoteError).details).toMatchObject({
      kind: 'path_access',
      resolvedPath: '/etc/shadow',
    });
    expect((error as RemoteError).message).toContain('/etc/shadow');
  });

  it('leaves an aborted handler alone so the session answers CANCELLED', async () => {
    // The gate must not wrap an AbortError: the SDK maps it to CANCELLED, and
    // an INTERNAL here would read as a crash instead of a cancellation. The
    // local receipt still needs the code — outcome is `error`, code CANCELLED.
    const audit = new FakeAuditSink();
    const handlers = new FakeRuntimeHandlers({
      'shell.run': () => {
        throw new DOMException('The request was cancelled.', 'AbortError');
      },
    });
    const gated = gateHandlers(handlers.map, { ...deps(), audit });

    const error = await call(gated, 'shell.run').catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe('AbortError');
    expect(audit.records).toEqual([
      expect.objectContaining({
        method: 'shell.run',
        outcome: 'error',
        code: 'CANCELLED',
      }),
    ]);
  });

  it('releases the in-flight slot when a handler throws', async () => {
    const audit = new FakeAuditSink();
    const handlers = new FakeRuntimeHandlers({
      'fs.read-file': () => {
        throw new Error('disk went away');
      },
    });
    const gated = gateHandlers(handlers.map, { ...deps(), audit });

    await call(gated, 'fs.read-file').catch(() => undefined);

    // A leaked slot would refuse every later update for the life of the session.
    await expect(call(gated, 'runtime.update.begin')).resolves.toEqual({ ok: true });
    expect(audit.records[0]).toMatchObject({
      method: 'fs.read-file',
      outcome: 'error',
      code: 'INTERNAL',
    });
  });
});
