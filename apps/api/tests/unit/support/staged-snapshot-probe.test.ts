import { describe, expect, it } from 'bun:test';

import {
  explainStagedSnapshotSupport,
  type StagedSnapshotProbeSource,
} from '../../support/staged-snapshot-probe';

const ALL_METHODS = ['snapshot.read-chunk', 'snapshot.stage-chunk', 'snapshot.release'];

/** A connection manager whose status, connect and discover answers are scripted. */
class ScriptedConnectionManager implements StagedSnapshotProbeSource {
  constructor(
    private readonly script: {
      readonly status?: unknown;
      readonly connectError?: Error;
      readonly discover?: { readonly methods: readonly string[] } | Error | undefined;
    }
  ) {}

  getStatus(): unknown {
    return this.script.status ?? { state: 'connected' };
  }

  getClient(): Promise<unknown> {
    return this.script.connectError
      ? Promise.reject(this.script.connectError)
      : Promise.resolve({});
  }

  discoverImplementation(): Promise<{ readonly methods: readonly string[] } | undefined> {
    const answer = this.script.discover;
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  }
}

describe('explainStagedSnapshotSupport', () => {
  it('names a failed connect and the status it started from', async () => {
    const manager = new ScriptedConnectionManager({
      status: { state: 'error' },
      connectError: new Error('handshake closed'),
    });

    expect(await explainStagedSnapshotSupport(manager, 'user-1', 'local')).toBe(
      '(staged snapshots, local): getClient failed: Error: handshake closed | status before probe: {"state":"error"}'
    );
  });

  it('names a failed runtime.discover', async () => {
    const manager = new ScriptedConnectionManager({
      discover: new Error('timed out after 5000ms'),
    });

    expect(await explainStagedSnapshotSupport(manager, 'user-1', 'local')).toBe(
      '(staged snapshots, local): runtime.discover failed: Error: timed out after 5000ms | status before probe: {"state":"connected"}'
    );
  });

  it('says when the runtime announced no implementation', async () => {
    const manager = new ScriptedConnectionManager({ discover: undefined });

    expect(await explainStagedSnapshotSupport(manager, 'user-1', 'local')).toContain(
      'no implementation announced'
    );
  });

  it('lists the staging methods the runtime lacks', async () => {
    const manager = new ScriptedConnectionManager({ discover: { methods: ['snapshot.release'] } });

    expect(await explainStagedSnapshotSupport(manager, 'user-1', 'local')).toContain(
      'missing snapshot.read-chunk, snapshot.stage-chunk'
    );
  });

  it('reports every staging method present', async () => {
    const manager = new ScriptedConnectionManager({ discover: { methods: ALL_METHODS } });

    expect(await explainStagedSnapshotSupport(manager, 'user-1', 'local')).toContain(
      'every staging method present'
    );
  });
});
