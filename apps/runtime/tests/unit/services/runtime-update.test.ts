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
import { tmpdir } from 'node:os';
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

    await Bun.sleep(20);
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
