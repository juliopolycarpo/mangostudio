import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { RUNTIME_BINARY_BASENAME } from '@mangostudio/shared/runtime-home';
import {
  readRuntimeSlotConfig,
  runtimeSlotDir,
  writeRuntimeSlotConfig,
} from '../../../src/runtime-home';
import { createRuntimeUpdateService } from '../../../src/services/runtime-update';

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function fixture() {
  const mangoHome = await mkdtemp(join(tmpdir(), 'mango-runtime-update-'));
  homes.push(mangoHome);
  const env = { MANGO_HOME: mangoHome };
  const slotDir = runtimeSlotDir('remote', env);
  const oldDir = join(slotDir, '1.0.0');
  const oldBinary = join(oldDir, RUNTIME_BINARY_BASENAME);
  await mkdir(oldDir, { recursive: true });
  await writeFile(oldBinary, 'old-runtime');
  await chmod(oldBinary, 0o755);
  await symlink('1.0.0', join(slotDir, 'current'));
  await writeRuntimeSlotConfig(
    'remote',
    { version: '1.0.0', binaryPath: oldBinary, digest: digestOf('old-runtime') },
    env
  );

  return {
    env,
    oldBinary,
    slotDir,
    service: createRuntimeUpdateService({ slot: 'remote', env }),
  };
}

function digestOf(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

describe('runtime self-update', () => {
  it('publishes verified bytes through current while the old inode stays readable', async () => {
    const { env, oldBinary, service, slotDir } = await fixture();
    const nextBytes = new TextEncoder().encode('new-runtime');
    const oldHandle = await open(oldBinary, 'r');

    try {
      const begun = await service.begin({
        version: '1.1.0',
        digest: digestOf(nextBytes),
        totalBytes: nextBytes.byteLength,
      });
      await service.chunk({
        sessionId: begun.sessionId,
        seq: 0,
        bytesBase64: Buffer.from(nextBytes).toString('base64'),
      });
      const committed = await service.commit({ sessionId: begun.sessionId });

      expect(committed).toEqual({
        version: '1.1.0',
        digest: digestOf(nextBytes),
        restart: 'manual',
      });
      expect(await readlink(join(slotDir, 'current'))).toBe('1.1.0');
      expect(await readFile(join(slotDir, 'current', RUNTIME_BINARY_BASENAME), 'utf8')).toBe(
        'new-runtime'
      );
      expect((await oldHandle.readFile()).toString()).toBe('old-runtime');
      expect(await readRuntimeSlotConfig('remote', env)).toMatchObject({
        version: '1.1.0',
        digest: digestOf(nextBytes),
      });
    } finally {
      await oldHandle.close();
      await service.close();
    }
  });

  // #799: a rolling channel reuses one version string and one asset name across
  // builds, so the commit is the only thing that says which build this is.
  describe('source commit provenance', () => {
    /** Runs one whole update, returning what the slot config ended up recording. */
    async function update(
      env: Record<string, string>,
      service: ReturnType<typeof createRuntimeUpdateService>,
      version: string,
      params: { readonly sourceSha?: string | null }
    ) {
      const bytes = new TextEncoder().encode(`runtime-${version}`);
      const begun = await service.begin({
        version,
        digest: digestOf(bytes),
        totalBytes: bytes.byteLength,
        ...params,
      });
      await service.chunk({
        sessionId: begun.sessionId,
        seq: 0,
        bytesBase64: Buffer.from(bytes).toString('base64'),
      });
      await service.commit({ sessionId: begun.sessionId });
      return await readRuntimeSlotConfig('remote', env);
    }

    it('records the commit a rolling build was built from', async () => {
      const { env, service } = await fixture();
      try {
        const config = await update(env, service, '1.1.0', { sourceSha: 'abc1234' });
        expect(config.sourceSha).toBe('abc1234');
      } finally {
        await service.close();
      }
    });

    // The write merges, so an update that says nothing about the commit used to
    // leave the *previous* build's next to the new binary. Stale provenance
    // reads as confident and wrong; missing provenance only reads as missing.
    it('clears a recorded commit when the new build has none', async () => {
      const { env, service } = await fixture();
      try {
        expect((await update(env, service, '1.1.0', { sourceSha: 'abc1234' })).sourceSha).toBe(
          'abc1234'
        );
        expect((await update(env, service, '1.2.0', {})).sourceSha).toBeNull();
        expect((await update(env, service, '1.3.0', { sourceSha: 'def5678' })).sourceSha).toBe(
          'def5678'
        );
        expect((await update(env, service, '1.4.0', { sourceSha: null })).sourceSha).toBeNull();
      } finally {
        await service.close();
      }
    });

    // The slot schema bounds this field, and a config that fails validation is
    // discarded whole — consent included. It is refused here, not written.
    it('refuses a value that is not a commit sha, before staging anything', async () => {
      const { env, service } = await fixture();
      const bytes = new TextEncoder().encode('new-runtime');
      try {
        await expect(
          service.begin({
            version: '1.1.0',
            digest: digestOf(bytes),
            totalBytes: bytes.byteLength,
            sourceSha: `${'0'.repeat(64)}-and-then-some`,
          })
        ).rejects.toMatchObject({ data: { reason: 'invalid_source_sha' } });
        expect(service.active).toBe(false);
        expect((await readRuntimeSlotConfig('remote', env)).version).toBe('1.0.0');
      } finally {
        await service.close();
      }
    });
  });

  it('reports a scheduled restart and notifies its supervisor after replying', async () => {
    const { env } = await fixture();
    let restarted = false;
    const service = createRuntimeUpdateService({
      slot: 'remote',
      env,
      supervised: true,
      requestRestart: () => {
        restarted = true;
      },
    });
    const bytes = new TextEncoder().encode('supervised-runtime');
    const begun = await service.begin({
      version: '1.1.0',
      digest: digestOf(bytes),
      totalBytes: bytes.byteLength,
    });
    await service.chunk({
      sessionId: begun.sessionId,
      seq: 0,
      bytesBase64: Buffer.from(bytes).toString('base64'),
    });

    await expect(service.commit({ sessionId: begun.sessionId })).resolves.toMatchObject({
      restart: 'scheduled',
    });
    expect(restarted).toBe(false);
    await Bun.sleep(75);
    expect(restarted).toBe(true);
  });

  it('removes a corrupt stage and leaves the current slot untouched', async () => {
    const { service, slotDir } = await fixture();
    const bytes = new TextEncoder().encode('tampered-runtime');
    const begun = await service.begin({
      version: '1.1.0',
      digest: digestOf('expected-runtime'),
      totalBytes: bytes.byteLength,
    });
    await service.chunk({
      sessionId: begun.sessionId,
      seq: 0,
      bytesBase64: Buffer.from(bytes).toString('base64'),
    });

    await expect(service.commit({ sessionId: begun.sessionId })).rejects.toThrow(
      `expected ${digestOf('expected-runtime')}, got ${digestOf(bytes)}`
    );
    expect(await readlink(join(slotDir, 'current'))).toBe('1.0.0');
    expect(
      await stat(join(slotDir, '1.1.0', `${RUNTIME_BINARY_BASENAME}.incoming`)).catch(() => null)
    ).toBeNull();
  });

  it('cleans an interrupted transfer so the next begin starts from byte zero', async () => {
    const { service, slotDir } = await fixture();
    const begun = await service.begin({
      version: '1.1.0',
      digest: digestOf('complete-runtime'),
      totalBytes: 16,
    });
    await service.chunk({
      sessionId: begun.sessionId,
      seq: 0,
      bytesBase64: Buffer.from('partial').toString('base64'),
    });
    await service.close();

    expect(
      await stat(join(slotDir, '1.1.0', `${RUNTIME_BINARY_BASENAME}.incoming`)).catch(() => null)
    ).toBeNull();
    const retry = await service.begin({
      version: '1.1.0',
      digest: digestOf('complete-runtime'),
      totalBytes: 16,
    });
    expect(retry.sessionId).not.toBe(begun.sessionId);
    await service.close();
  });

  // A refusal that kept the session would hold the whole host hostage: every
  // ordinary call is refused while one is open, so an early commit has to end
  // it rather than wait out the timeout.
  it('ends the session when commit arrives before the last byte', async () => {
    const { service, slotDir } = await fixture();
    const begun = await service.begin({
      version: '1.1.0',
      digest: digestOf('complete-runtime'),
      totalBytes: 16,
    });
    await service.chunk({
      sessionId: begun.sessionId,
      seq: 0,
      bytesBase64: Buffer.from('partial').toString('base64'),
    });

    await expect(service.commit({ sessionId: begun.sessionId })).rejects.toThrow(
      'received 7 of 16 bytes'
    );
    expect(service.active).toBe(false);
    expect(
      await stat(join(slotDir, '1.1.0', `${RUNTIME_BINARY_BASENAME}.incoming`)).catch(() => null)
    ).toBeNull();
    expect(await readlink(join(slotDir, 'current'))).toBe('1.0.0');

    // The lock went with it, so the next attempt is not locked out.
    const retry = await service.begin({
      version: '1.1.0',
      digest: digestOf('complete-runtime'),
      totalBytes: 16,
    });
    expect(retry.sessionId).not.toBe(begun.sessionId);
    await service.close();
  });

  it('keeps another process reclaim guard while pruning old slot versions', async () => {
    const { service, slotDir } = await fixture();
    const reclaimPath = join(slotDir, 'runtime-update.lock.reclaim');
    await mkdir(join(slotDir, '0.9.0'), { recursive: true });
    const nextBytes = new TextEncoder().encode('new-runtime');

    const begun = await service.begin({
      version: '1.1.0',
      digest: digestOf(nextBytes),
      totalBytes: nextBytes.byteLength,
    });
    // Another process starts weighing this lock only after ours is held; the
    // guard is what stops two of them reclaiming it at once.
    await writeFile(reclaimPath, '');
    await service.chunk({
      sessionId: begun.sessionId,
      seq: 0,
      bytesBase64: Buffer.from(nextBytes).toString('base64'),
    });
    await service.commit({ sessionId: begun.sessionId });

    expect(await stat(reclaimPath).catch(() => null)).not.toBeNull();
    // The version two releases back is still collected.
    expect(await stat(join(slotDir, '0.9.0')).catch(() => null)).toBeNull();
    await service.close();
  });

  it('refuses concurrent sessions and out-of-sequence chunks', async () => {
    const { service } = await fixture();
    const begin = {
      version: '1.1.0',
      digest: digestOf('next'),
      totalBytes: 4,
    } as const;
    const begun = await service.begin(begin);

    await expect(service.begin(begin)).rejects.toThrow('already active');
    await expect(
      service.chunk({
        sessionId: begun.sessionId,
        seq: 1,
        bytesBase64: Buffer.from('next').toString('base64'),
      })
    ).rejects.toThrow('expected chunk 0, received 1');
    await service.close();
  });

  it('serializes concurrent chunks so one sequence number is accepted once', async () => {
    const { service } = await fixture();
    const begun = await service.begin({
      version: '1.1.0',
      digest: digestOf('next'),
      totalBytes: 4,
    });
    const chunk = {
      sessionId: begun.sessionId,
      seq: 0,
      bytesBase64: Buffer.from('next').toString('base64'),
    } as const;

    const results = await Promise.allSettled([service.chunk(chunk), service.chunk(chunk)]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await expect(service.commit({ sessionId: begun.sessionId })).resolves.toMatchObject({
      version: '1.1.0',
    });
  });

  it('serializes concurrent begins so only one stage becomes active', async () => {
    const { service } = await fixture();
    const begin = {
      version: '1.1.0',
      digest: digestOf('next'),
      totalBytes: 4,
    } as const;

    const results = await Promise.allSettled([service.begin(begin), service.begin(begin)]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(service.active).toBe(true);
    await service.close();
  });

  it('holds one update lock across service instances for the whole slot session', async () => {
    const { env, service } = await fixture();
    const contender = createRuntimeUpdateService({ slot: 'remote', env });
    const begin = {
      version: '1.1.0',
      digest: digestOf('next'),
      totalBytes: 4,
    } as const;

    const begun = await service.begin(begin);
    await expect(contender.begin(begin)).rejects.toThrow('slot update is already active');

    await service.close();
    await expect(contender.begin(begin)).resolves.toMatchObject({
      sessionId: expect.any(String),
    });
    expect(begun.sessionId).not.toBe('');
    await contender.close();
  });

  it('reclaims a slot update lock whose local owner process is gone', async () => {
    const { service, slotDir } = await fixture();
    const lockPath = join(slotDir, 'runtime-update.lock');
    await writeFile(
      lockPath,
      JSON.stringify({ token: 'abandoned', pid: 2_147_483_647, host: hostname() })
    );

    await expect(
      service.begin({ version: '1.1.0', digest: digestOf('next'), totalBytes: 4 })
    ).resolves.toMatchObject({ sessionId: expect.any(String) });
    await service.close();

    expect(await stat(lockPath).catch(() => null)).toBeNull();
  });

  it('retries partial file writes until every confirmed byte is staged', async () => {
    const { env, slotDir } = await fixture();
    let writes = 0;
    const service = createRuntimeUpdateService({
      slot: 'remote',
      env,
      writeChunk: async (handle, bytes) => {
        writes += 1;
        const slice = bytes.subarray(0, Math.min(2, bytes.byteLength));
        return (await handle.write(slice)).bytesWritten;
      },
    });
    const bytes = new TextEncoder().encode('partial-write-runtime');
    const begun = await service.begin({
      version: '1.1.0',
      digest: digestOf(bytes),
      totalBytes: bytes.byteLength,
    });

    await expect(
      service.chunk({
        sessionId: begun.sessionId,
        seq: 0,
        bytesBase64: Buffer.from(bytes).toString('base64'),
      })
    ).resolves.toEqual({ acceptedBytes: bytes.byteLength, receivedBytes: bytes.byteLength });
    await service.commit({ sessionId: begun.sessionId });

    expect(writes).toBeGreaterThan(1);
    expect(await readFile(join(slotDir, 'current', RUNTIME_BINARY_BASENAME), 'utf8')).toBe(
      'partial-write-runtime'
    );
  });

  it('refuses chunks without a session and malformed base64 without writing bytes', async () => {
    const { service } = await fixture();
    await expect(
      service.chunk({ sessionId: 'absent', seq: 0, bytesBase64: 'bmV4dA==' })
    ).rejects.toThrow('absent or no longer active');

    const begun = await service.begin({
      version: '1.1.0',
      digest: digestOf('next'),
      totalBytes: 4,
    });
    await expect(
      service.chunk({ sessionId: begun.sessionId, seq: 0, bytesBase64: '*not-base64*' })
    ).rejects.toThrow('not canonical base64');
    await service.close();
  });

  it('expires an abandoned session and removes its stage', async () => {
    const { env, slotDir } = await fixture();
    const service = createRuntimeUpdateService({ slot: 'remote', env, sessionTimeoutMs: 5 });
    await service.begin({ version: '1.1.0', digest: digestOf('next'), totalBytes: 4 });

    // The timeout does not end the session itself: it schedules a serialized
    // async discard, and `active` stays true until that finishes. Waited out
    // rather than raced with a fixed sleep, because the margin that holds on an
    // idle laptop does not hold on a loaded runner under coverage.
    const deadline = Date.now() + 5_000;
    while (service.active && Date.now() < deadline) await Bun.sleep(5);

    expect(service.active).toBe(false);
    expect(
      await stat(join(slotDir, '1.1.0', `${RUNTIME_BINARY_BASENAME}.incoming`)).catch(() => null)
    ).toBeNull();
  });

  it('refuses Windows before creating a stage', async () => {
    const { env } = await fixture();
    const service = createRuntimeUpdateService({ slot: 'remote', env, platform: 'win32' });

    await expect(
      service.begin({ version: '1.1.0', digest: digestOf('next'), totalBytes: 4 })
    ).rejects.toThrow('not available on Windows');
  });
});
