import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RUNTIME_CONSENT_PRESETS } from '@mangostudio/shared/runtime-home';
import {
  connectInProcessRuntime,
  createLocalRuntimeHost,
  RuntimeHost,
  type RuntimeMethodHandler,
} from '../../src';
import { runtimeSlotDir } from '../../src/runtime-home';

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
    const host = createLocalRuntimeHost({
      runtimeVersion: '1.0.0',
      allow: { ...RUNTIME_CONSENT_PRESETS.full, update: false },
      slot: 'remote',
      update: { env },
    });
    const connection = await connectInProcessRuntime(host, { hubVersion: '1.1.0' });

    try {
      await expect(
        connection.client.request('runtime.update.begin', beginParams())
      ).rejects.toMatchObject({
        code: 'RUNTIME_DENIED',
      });
      expect(await stat(join(runtimeSlotDir('remote', env), '1.1.0')).catch(() => null)).toBeNull();
    } finally {
      connection.close();
    }
  });

  it('refuses an update begin while another call is in flight', async () => {
    const forever: RuntimeMethodHandler = (_params, context) =>
      new Promise((_resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      });
    const host = new RuntimeHost({
      runtimeVersion: '1.0.0',
      manifest: {
        platform: 'linux',
        arch: 'x64',
        pathStyle: 'posix',
        homeDir: '/tmp',
        shells: [],
        git: { available: false },
        features: {
          tools: true,
          git: false,
          probing: false,
          mcp: false,
          library: false,
          checkpoints: false,
        },
      },
      handlers: new Map<string, RuntimeMethodHandler>([
        ['test.forever', forever],
        ['runtime.update.begin', async () => ({ sessionId: 'unexpected', maxChunkBytes: 1 })],
      ]),
    });
    const connection = await connectInProcessRuntime(host, { hubVersion: '1.1.0' });
    const untyped = connection.client as unknown as {
      request(method: string, params: unknown): Promise<unknown>;
    };
    const pending = untyped.request('test.forever', {});
    await Promise.resolve();

    try {
      await expect(
        connection.client.request('runtime.update.begin', beginParams())
      ).rejects.toMatchObject({
        code: 'RUNTIME_UPDATE_REFUSED',
        details: { reason: 'call_in_flight' },
      });
    } finally {
      connection.close();
      await pending.catch(() => undefined);
    }
  });

  it('refuses ordinary calls while an update session is open', async () => {
    const env = await isolatedEnv();
    const host = createLocalRuntimeHost({
      runtimeVersion: '1.0.0',
      allow: RUNTIME_CONSENT_PRESETS.full,
      slot: 'remote',
      update: { env },
    });
    const connection = await connectInProcessRuntime(host, { hubVersion: '1.1.0' });

    try {
      await connection.client.request('runtime.update.begin', beginParams());
      await expect(connection.client.request('runtime.health', {})).rejects.toMatchObject({
        code: 'RUNTIME_UPDATE_REFUSED',
        details: { reason: 'update_in_progress' },
      });
    } finally {
      connection.close();
    }
  });
});
