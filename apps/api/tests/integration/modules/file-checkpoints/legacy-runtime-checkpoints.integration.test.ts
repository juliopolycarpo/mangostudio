/**
 * Checkpoints against a remote runtime that predates the staging methods
 * (issue #762). SSH and HTTP environments connect without requiring the hub's
 * release, so such a runtime can sit behind a current hub: it captures at most
 * 8 MiB inline, has no `snapshot.stage-chunk`, and rejects a revert operation
 * that names `stagedId`. The hub must read what the runtime advertises and fall
 * back to the inline behaviour instead of sending it parameters or methods it
 * refuses.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { RemoteError, RESERVED_ERROR_CODES } from '@mangostudio/protocol';
import type {
  RuntimeCapabilityManifest,
  RuntimeDiscoverResult,
  RuntimeSnapshotRevertParams,
} from '@mangostudio/shared/runtime-contract';
import { fixtures } from '@mangostudio/shared/test-utils';

import { getDb } from '../../../../src/db/database';
import { getConfig } from '../../../../src/lib/config';
import {
  FileCheckpointConflictError,
  revertMessageFileCheckpoints,
} from '../../../../src/modules/file-checkpoints/application/revert-message-checkpoints';
import { storeCheckpointBlob } from '../../../../src/modules/file-checkpoints/infrastructure/checkpoint-blob-store';
import { insertCheckpointRow } from '../../../../src/modules/file-checkpoints/infrastructure/checkpoint-repository';
import type { RuntimeClient } from '../../../../src/services/runtime-client/runtime-client';
import {
  type ManagedRuntimeConnection,
  RuntimeConnectionManager,
  setRuntimeConnectionManagerForTests,
} from '../../../../src/services/runtime-client/runtime-connection-manager';
import { RuntimeDiscoveryCache } from '../../../../src/services/runtime-client/runtime-discovery-cache';
import { snapshotCaptureParams } from '../../../../src/services/tools/file-mutation-snapshot';
import type { ToolContext } from '../../../../src/services/tools/types';
import {
  type ChatFixture,
  insertTestChat,
  insertTestUser,
  type UserFixture,
} from '../../../support/factories';

const MIB = 1024 * 1024;
const ENVIRONMENT_ID = 'remote-box';
const FINGERPRINT = 'c'.repeat(64);

/** The methods a runtime built before the staging methods implements for checkpoints. */
const LEGACY_METHODS = [
  'runtime.discover',
  'runtime.health',
  'fs.read-file',
  'fs.write-file',
  'fs.move-file',
  'snapshot.capture',
  'snapshot.hash',
  'snapshot.revert',
];

const STAGING_METHODS = ['snapshot.read-chunk', 'snapshot.stage-chunk', 'snapshot.release'];

const FEATURES = {
  git: false,
  probing: false,
  mcp: false,
  library: false,
  checkpoints: true,
  fsRead: true,
  fsWrite: true,
  shell: false,
  update: false,
  externalAgents: false,
  terminal: false,
};

const MANIFEST: RuntimeCapabilityManifest = {
  platform: 'linux',
  arch: 'x64',
  pathStyle: 'posix',
  homeDir: '/home/remote',
  shells: ['bash'],
  git: { available: false },
  features: {
    tools: true,
    git: false,
    probing: false,
    mcp: false,
    library: false,
    checkpoints: true,
  },
  implementation: { schema: 1, fingerprint: FINGERPRINT, features: FEATURES },
};

/**
 * A remote runtime from before the staging methods. It answers `runtime.discover`
 * with the methods it has, and behaves like the old Rust runtime for everything
 * else: an unknown method is `METHOD_UNSUPPORTED`, and a revert operation
 * without `contentBase64` fails parameter validation.
 */
class LegacyRuntimeConnection implements ManagedRuntimeConnection {
  readonly stagingCalls: string[] = [];
  readonly reverts: RuntimeSnapshotRevertParams[] = [];
  readonly client: RuntimeClient;
  readonly close = () => undefined;

  constructor(methods: readonly string[] = LEGACY_METHODS) {
    const unsupported = (method: string) => (): Promise<never> => {
      this.stagingCalls.push(method);
      return Promise.reject(
        new RemoteError(RESERVED_ERROR_CODES.METHOD_UNSUPPORTED, `Method not found: ${method}`)
      );
    };
    this.client = {
      manifest: MANIFEST,
      discoverImplementation: (): Promise<RuntimeDiscoverResult> =>
        Promise.resolve({
          schema: 1,
          fingerprint: FINGERPRINT,
          features: FEATURES,
          methods: [...methods],
        }),
      snapshot: {
        readChunk: unsupported('snapshot.read-chunk'),
        stageChunk: unsupported('snapshot.stage-chunk'),
        release: unsupported('snapshot.release'),
        revert: (params: RuntimeSnapshotRevertParams) => {
          for (const operation of params.operations) {
            if ('stagedId' in operation) {
              return Promise.reject(
                new RemoteError(
                  RESERVED_ERROR_CODES.INVALID_PARAMS,
                  'operations[].contentBase64: required property is missing'
                )
              );
            }
          }
          this.reverts.push(params);
          return Promise.resolve({ revertedFiles: params.operations.length });
        },
      },
    } as unknown as RuntimeClient;
  }
}

/** A connection whose `runtime.discover` fails, like a peer that cannot answer it. */
class UndiscoverableRuntimeConnection implements ManagedRuntimeConnection {
  readonly close = () => undefined;
  readonly client = {
    manifest: MANIFEST,
    discoverImplementation: () => Promise.reject(new Error('runtime.discover timed out')),
  } as unknown as RuntimeClient;
}

function useRuntime(connection: ManagedRuntimeConnection, userId: string): void {
  setRuntimeConnectionManagerForTests(
    new RuntimeConnectionManager({
      resolveEnvironment: () =>
        Promise.resolve({
          id: ENVIRONMENT_ID,
          userId,
          name: 'Remote box',
          transportKind: 'stdio' as const,
          config: {},
          enabled: true,
        }),
      connectors: { stdio: () => Promise.resolve(connection) },
      discoveryCache: new RuntimeDiscoveryCache(),
    })
  );
}

let user: UserFixture;
let chat: ChatFixture;
let messageId: string;

beforeAll(async () => {
  user = await insertTestUser();
});

beforeEach(async () => {
  chat = await insertTestChat(user.id);
  messageId = fixtures.uuid();
  await getDb()
    .insertInto('messages')
    .values({
      id: messageId,
      chatId: chat.id,
      role: 'ai',
      text: '',
      imageUrl: null,
      referenceImage: null,
      timestamp: Date.now(),
      isGenerating: 0,
      generationTime: null,
      modelName: null,
      styleParams: null,
      interactionMode: 'chat',
      parts: null,
      providerState: null,
    })
    .execute();
});

afterEach(() => {
  setRuntimeConnectionManagerForTests(undefined);
});

function turnContext(): ToolContext {
  return {
    userId: chat.userId,
    chatId: chat.id,
    environmentId: ENVIRONMENT_ID,
    assistantMessageId: messageId,
    db: getDb(),
    workdir: '/work',
    parameters: {},
  };
}

/** Non-repeating bytes, so a dropped or reordered chunk changes the digest. */
function patternBytes(length: number): Buffer {
  const bytes = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) bytes[index] = (index * 131) % 251;
  return bytes;
}

/** Records an edited file whose pre-edit content is `bytes`, as a capture would have. */
async function recordEditCheckpoint(path: string, bytes: Buffer): Promise<string> {
  const blobKey = await storeCheckpointBlob(bytes);
  await insertCheckpointRow(getDb(), {
    chatId: chat.id,
    messageId,
    environmentId: ENVIRONMENT_ID,
    path,
    op: 'edit',
    beforeHash: blobKey,
    afterHash: 'a'.repeat(64),
    movedTo: null,
    blobKey,
  });
  return blobKey;
}

describe('capture against a runtime that predates the staging methods', () => {
  it('does not send snapshotMaxBytes', async () => {
    useRuntime(new LegacyRuntimeConnection(), user.id);

    const params = await snapshotCaptureParams(turnContext());

    expect(params).toEqual({ captureSnapshot: true });
  });

  it('does not send snapshotMaxBytes when runtime.discover cannot be answered', async () => {
    useRuntime(new UndiscoverableRuntimeConnection(), user.id);

    const params = await snapshotCaptureParams(turnContext());

    expect(params).toEqual({ captureSnapshot: true });
  });

  it('does not send it when only some of the staging methods exist', async () => {
    useRuntime(
      new LegacyRuntimeConnection([...LEGACY_METHODS, 'snapshot.read-chunk', 'snapshot.release']),
      user.id
    );

    const params = await snapshotCaptureParams(turnContext());

    expect(params).toEqual({ captureSnapshot: true });
  });

  it('sends the configured limit once the runtime advertises every staging method', async () => {
    useRuntime(new LegacyRuntimeConnection([...LEGACY_METHODS, ...STAGING_METHODS]), user.id);

    const params = await snapshotCaptureParams(turnContext());

    expect(params).toEqual({
      captureSnapshot: true,
      snapshotMaxBytes: getConfig().checkpoints.maxFileBytes,
    });
  });
});

describe('revert against a runtime that predates the staging methods', () => {
  it('restores a blob past 1 MiB inline, as before staging existed', async () => {
    const connection = new LegacyRuntimeConnection();
    useRuntime(connection, user.id);
    const bytes = patternBytes(3 * MIB);
    await recordEditCheckpoint('/work/mid.bin', bytes);

    await revertMessageFileCheckpoints(getDb(), chat.id, messageId);

    expect(connection.stagingCalls).toEqual([]);
    expect(connection.reverts).toHaveLength(1);
    expect(connection.reverts[0]?.operations).toEqual([
      { type: 'restore', path: '/work/mid.bin', contentBase64: bytes.toString('base64') },
    ]);
  });

  it('refuses a blob past what the runtime could ever have captured, before sending anything', async () => {
    const connection = new LegacyRuntimeConnection();
    useRuntime(connection, user.id);
    const size = 9 * MIB;
    await recordEditCheckpoint('/work/big.bin', patternBytes(size));

    const error = await revertMessageFileCheckpoints(getDb(), chat.id, messageId).then(
      () => null,
      (reason: unknown) => reason
    );

    expect(error).toBeInstanceOf(FileCheckpointConflictError);
    expect((error as FileCheckpointConflictError).message).toContain(`${size} bytes`);
    expect((error as FileCheckpointConflictError).message).toContain('Update that runtime');
    expect(connection.stagingCalls).toEqual([]);
    expect(connection.reverts).toEqual([]);
  });

  it('stages a blob past 1 MiB once the runtime advertises the staging methods', async () => {
    const connection = new LegacyRuntimeConnection([...LEGACY_METHODS, ...STAGING_METHODS]);
    useRuntime(connection, user.id);
    await recordEditCheckpoint('/work/staged.bin', patternBytes(3 * MIB));

    // The fake still lacks the staging methods, so the upload is refused; what
    // matters is that the hub chose the staging path for a runtime that claims it.
    await revertMessageFileCheckpoints(getDb(), chat.id, messageId).catch(() => undefined);

    expect(connection.stagingCalls).toContain('snapshot.stage-chunk');
  });
});
