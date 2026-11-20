import { afterEach, describe, expect, it } from 'bun:test';

import { LocalRuntimeLossWatch } from '../../support/local-runtime-loss-watch';

/** The hub's own line format, as `logDiagnostic` writes it. */
function hubLine(scope: string, event: string, metadata: Record<string, unknown>): string {
  return JSON.stringify({ level: 'warn', scope, event, ts: 1, metadata });
}

const watches: LocalRuntimeLossWatch[] = [];
function startedWatch(): LocalRuntimeLossWatch {
  const watch = new LocalRuntimeLossWatch();
  watches.push(watch);
  watch.start();
  return watch;
}

afterEach(() => {
  for (const watch of watches.splice(0)) watch.stop();
});

describe('LocalRuntimeLossWatch', () => {
  it('names the loss events the hub logged and nothing else', () => {
    const watch = startedWatch();
    console.warn(hubLine('runtime-stdio', 'child_ended', { exitCode: 101, signal: null }));
    console.warn(hubLine('runtime-local', 'attestation_withdrawn', { arrivingUserId: 'u2' }));
    console.warn(hubLine('other', 'unrelated_event', { noise: true }));
    console.warn('plain text warning');

    const explanation = watch.explain();
    expect(explanation).toContain('"exitCode":101');
    expect(explanation).toContain('attestation_withdrawn');
    expect(explanation).not.toContain('unrelated_event');
    expect(explanation).not.toContain('plain text warning');
  });

  it('says that nothing was logged when the connection was never reported lost', () => {
    const watch = startedWatch();

    expect(watch.explain()).toContain('no child_ended, connection_lost or attestation_withdrawn');
  });

  it('restores console.warn and the diagnostic flag on stop', () => {
    const warnBefore = console.warn;
    const flagBefore = process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS;
    const watch = startedWatch();
    expect(process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS).toBe('1');

    watch.stop();

    expect(console.warn).toBe(warnBefore);
    expect(process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS).toBe(flagBefore);
  });

  it('rethrows a rejection with the explanation and keeps the original as cause', async () => {
    const watch = startedWatch();
    console.warn(hubLine('runtime-stdio', 'connection_lost', { reason: 'pipe closed' }));
    const original = new Error('Request "fs.move-file" cannot complete');

    const thrown = await watch
      .explaining(() => Promise.reject(original))
      .then(
        () => null,
        (reason: unknown) => reason
      );

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('Request "fs.move-file" cannot complete');
    expect((thrown as Error).message).toContain('pipe closed');
    expect((thrown as Error).cause).toBe(original);
  });

  it('passes a resolved value through untouched', async () => {
    const watch = startedWatch();

    expect(await watch.explaining(() => Promise.resolve('moved'))).toBe('moved');
  });
});
