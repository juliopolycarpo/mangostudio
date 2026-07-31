import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeRuntimeBinary } from '../../../src/cli/runtime-binary-probe';

let workdir = '';

beforeAll(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'mango-runtime-probe-'));
});

afterAll(async () => {
  if (workdir) await rm(workdir, { force: true, recursive: true });
});

describe('probeRuntimeBinary', () => {
  it('reports a source checkout as nothing to check', async () => {
    expect(await probeRuntimeBinary(null)).toEqual({
      path: null,
      present: false,
      version: null,
      error: null,
    });
  });

  it('reports a missing sibling as absent rather than broken', async () => {
    const path = join(workdir, 'no-such-runtime');

    expect(await probeRuntimeBinary(path)).toEqual({
      path,
      present: false,
      version: null,
      error: null,
    });
  });

  // Doctor's whole job is to describe a broken install, so a path that exists
  // but cannot be executed has to come back as a finding. Spawning it throws
  // rather than resolving, which would otherwise take the whole command down.
  it('reports a path that exists but cannot be run', async () => {
    const path = join(workdir, 'runtime-is-a-directory');
    await mkdir(path, { recursive: true });

    const probe = await probeRuntimeBinary(path);

    expect(probe.path).toBe(path);
    expect(probe.present).toBe(true);
    expect(probe.version).toBeNull();
    expect(probe.error).toBeTruthy();
  });

  it.skipIf(process.platform === 'win32')(
    'reports a runtime that answers with a version',
    async () => {
      const path = join(workdir, 'fake-runtime');
      await writeFile(path, '#!/bin/sh\necho 1.2.3-test\n');
      await chmod(path, 0o755);

      expect(await probeRuntimeBinary(path)).toEqual({
        path,
        present: true,
        version: '1.2.3-test',
        error: null,
      });
    }
  );

  it.skipIf(process.platform === 'win32')('reports a runtime that exits non-zero', async () => {
    const path = join(workdir, 'failing-runtime');
    await writeFile(path, '#!/bin/sh\nexit 3\n');
    await chmod(path, 0o755);

    const probe = await probeRuntimeBinary(path);

    expect(probe.present).toBe(true);
    expect(probe.version).toBeNull();
    expect(probe.error).toBe('exited with code 3');
  });
});
