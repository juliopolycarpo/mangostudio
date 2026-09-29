import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadMetrics } from './load-metrics';
import { type ExpectedEnvelope, QA_METRICS_SCHEMA_VERSION } from './metrics-envelope';
import { makeMetrics } from './testing/metrics-fixture';

const SHA = `${'a'.repeat(39)}1`;
const FOUND = { found: true, reason: null };
const expected: ExpectedEnvelope = {
  repository: 'mango/studio',
  headSha: SHA,
  baseSha: null,
  prNumber: null,
};

const v4Envelope = {
  schemaVersion: QA_METRICS_SCHEMA_VERSION,
  repository: 'mango/studio',
  prNumber: null,
  baseSha: null,
  headSha: SHA,
  provenance: {
    sourceSha: SHA,
    producer: { name: 'mangostudio/qa-gate-collect', version: '0.1.1' },
    runId: 1,
    runAttempt: 1,
  },
  metrics: makeMetrics(SHA),
};

// A shape v3 really had: per-workspace maps and bare `{ error }` placeholders.
const v3Envelope = {
  schemaVersion: 3,
  repository: 'mango/studio',
  prNumber: null,
  baseSha: null,
  headSha: SHA,
  metrics: {
    sha: SHA,
    loc: { frontend: { files: 1, code: 100, comment: 0, blank: 0, total: 100 } },
  },
};

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const writeArtifact = async (contents: unknown): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'load-metrics-'));
  dirs.push(dir);
  const path = join(dir, 'metrics.json');
  await Bun.write(path, JSON.stringify(contents));
  return path;
};

describe('loadMetrics', () => {
  it('loads a valid v4 envelope', async () => {
    const loaded = await loadMetrics(await writeArtifact(v4Envelope), FOUND, expected, 'base');

    expect(loaded.note).toBeNull();
    expect(loaded.incomparable).toBe(false);
    expect(loaded.metrics?.sha).toBe(SHA);
  });

  it('reports a v3 baseline as incomparable, not as a delta source and not as a generic failure', async () => {
    const logged: string[] = [];

    const loaded = await loadMetrics(
      await writeArtifact(v3Envelope),
      FOUND,
      expected,
      'base',
      {},
      (message) => logged.push(message)
    );

    expect(loaded.metrics).toBeNull();
    expect(loaded.incomparable).toBe(true);
    expect(loaded.note).toContain('schema version 3 is incomparable with expected 4');
    expect(logged).toEqual([`base metrics rejected: ${loaded.note}`]);
  });

  it('rejects a v3 head the same way', async () => {
    const loaded = await loadMetrics(await writeArtifact(v3Envelope), FOUND, expected, 'head');

    expect(loaded.metrics).toBeNull();
    expect(loaded.incomparable).toBe(true);
  });

  it('a malformed v4 envelope is unavailable but not incomparable', async () => {
    const loaded = await loadMetrics(
      await writeArtifact({ ...v4Envelope, metrics: 'garbage' }),
      FOUND,
      expected,
      'base'
    );

    expect(loaded.metrics).toBeNull();
    expect(loaded.incomparable).toBe(false);
    expect(loaded.note).toContain('schema validation');
  });

  it('reports a missing artifact with the publisher reason', async () => {
    const loaded = await loadMetrics(
      null,
      { found: false, reason: 'run has no qa-metrics artifact' },
      expected,
      'base'
    );

    expect(loaded).toEqual({
      metrics: null,
      note: 'run has no qa-metrics artifact',
      incomparable: false,
    });
  });

  it('reports a payload that could not be extracted', async () => {
    const loaded = await loadMetrics('/nonexistent/metrics.json', FOUND, expected, 'head');

    expect(loaded.note).toBe('artifact payload could not be extracted');
  });
});
