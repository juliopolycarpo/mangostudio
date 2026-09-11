import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RUNTIME_CONSENT_PRESETS } from '@mangostudio/shared/runtime-home';
import { createLocalRuntimeHost } from '../../src';
import { runtimeSlotDir } from '../../src/runtime-home';
import { connectRuntimeDefinition } from '../support/hub-connection';

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function isolatedEnv(): Promise<NodeJS.ProcessEnv> {
  const mangoHome = await mkdtemp(join(tmpdir(), 'mango-runtime-update-protocol-'));
  homes.push(mangoHome);
  return { MANGO_HOME: mangoHome };
}

function beginParams() {
  return {
    version: '1.1.0',
    digest: `sha256:${createHash('sha256').update('next').digest('hex')}`,
    totalBytes: 4,
  };
}

describe('runtime update protocol policy', () => {
  it('refuses before staging when the machine denied allow.update', async () => {
    const env = await isolatedEnv();
    const connection = await connectRuntimeDefinition(
      createLocalRuntimeHost({
        runtimeVersion: '1.0.0',
        allow: { ...RUNTIME_CONSENT_PRESETS.full, update: false },
        slot: 'remote',
        update: { env },
      }),
      { hubVersion: '1.1.0' }
    );

    try {
      await expect(connection.request('runtime.update.begin', beginParams())).rejects.toMatchObject(
        {
          code: 'DENIED',
        }
      );
      expect(await stat(join(runtimeSlotDir('remote', env), '1.1.0')).catch(() => null)).toBeNull();
    } finally {
      await connection.close();
    }
  });

  it('refuses ordinary calls while an update session is open', async () => {
    const env = await isolatedEnv();
    const connection = await connectRuntimeDefinition(
      createLocalRuntimeHost({
        runtimeVersion: '1.0.0',
        allow: RUNTIME_CONSENT_PRESETS.full,
        slot: 'remote',
        update: { env },
      }),
      { hubVersion: '1.1.0' }
    );

    try {
      await connection.request('runtime.update.begin', beginParams());
      await expect(connection.request('runtime.health', {})).rejects.toMatchObject({
        code: 'RUNTIME_UPDATE_REFUSED',
        details: { reason: 'update_in_progress' },
      });
    } finally {
      await connection.close();
    }
  });
});
