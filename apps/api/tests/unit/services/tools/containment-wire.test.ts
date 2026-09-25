/**
 * What the hub actually puts on the wire when a chat is restricted to its
 * working directory.
 *
 * Containment is enforced on the machine that owns the filesystem, because only
 * that machine can follow a symbolic link and canonicalize a root in its own
 * path style. The hub's remaining job is to say which root applies — and an
 * executor that forgets to say it produces a call the runtime cannot refuse and
 * a suite that stays green, since the local case behaves identically either way.
 *
 * So these assert per executor, against the params the runtime received, rather
 * than in aggregate: a single "some call carried a root" assertion would pass
 * with ten of the eleven wired and the eleventh silently unrestricted.
 *
 * What is asserted is the hub's output, so the runtime is the fake host: each
 * handler records the params that crossed the wire and answers a well-formed
 * result. What a real runtime then does with the root is the runtime's own
 * suite's to prove.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import type { RuntimeMethod, RuntimePathFilter } from '@mangostudio/shared/runtime-contract';
import { RUNTIME_CONSENT_PRESETS } from '@mangostudio/shared/runtime-home';
import { RuntimeClient } from '../../../../src/services/runtime-client/runtime-client';
import {
  RuntimeConnectionManager,
  setRuntimeConnectionManagerForTests,
} from '../../../../src/services/runtime-client/runtime-connection-manager';
import { executeApplyPatch } from '../../../../src/services/tools/builtin/apply-patch';
import { executeCreateFile } from '../../../../src/services/tools/builtin/create-file';
import { executeDeleteFile } from '../../../../src/services/tools/builtin/delete-file';
import { executeEditFile } from '../../../../src/services/tools/builtin/edit-file';
import { executeGlob } from '../../../../src/services/tools/builtin/glob';
import { executeGrep } from '../../../../src/services/tools/builtin/grep';
import { executeListDirectory } from '../../../../src/services/tools/builtin/list-directory';
import { executeMoveFile } from '../../../../src/services/tools/builtin/move-file';
import { executeReadFile } from '../../../../src/services/tools/builtin/read-file';
import { executeReplaceRange } from '../../../../src/services/tools/builtin/replace-range';
import { executeWriteFile } from '../../../../src/services/tools/builtin/write-file';
import type { ToolContext } from '../../../../src/services/tools/types';
import {
  connectFakeRuntime,
  FakeRuntimeDefinition,
  fixedConsent,
  type TestHandler,
} from '../../../support/fake-runtime-host';
import { TEST_RUNTIME_MANIFEST } from '../../../support/runtime-fixture';

const VERSION = 'test';

/** The chat's working directory; nothing behind the fake runtime reads it. */
const workdir = '/workspace/project';

const SHA256 = '0'.repeat(64);

/** Params the runtime saw, by method, for the most recent call to each. */
type SentParams = Map<string, { readonly pathPolicy?: RuntimePathFilter }>;

let sent: SentParams;
let release: () => Promise<void>;

/** Every params object carries the path it names; results echo it back. */
type PathParams = { readonly resolvedPath: string };

/** A mutating method's envelope; no snapshot was asked for, so none is recorded. */
function mutation(result: unknown): unknown {
  return { result, mutations: [] };
}

/**
 * A well-formed answer per filesystem method, shaped as the contract's result
 * schema requires so the executor completes instead of failing on the reply.
 */
const ANSWERS: Partial<Record<RuntimeMethod, (params: never) => unknown>> = {
  'fs.read-file': (params: PathParams) => ({
    content: 'contents\n',
    path: params.resolvedPath,
    size: 9,
    sha256: SHA256,
    totalLines: 1,
    startLine: 1,
    endLine: 1,
    truncated: false,
  }),
  'fs.write-file': (params: PathParams) =>
    mutation({
      path: params.resolvedPath,
      bytesWritten: 9,
      created: true,
      sha256: SHA256,
    }),
  'fs.create-file': (params: PathParams) =>
    mutation({
      path: params.resolvedPath,
      bytesWritten: 9,
      sha256: SHA256,
    }),
  'fs.edit-file': (params: PathParams) =>
    mutation({
      path: params.resolvedPath,
      replacements: 1,
      sha256: SHA256,
      firstChangedLine: 1,
    }),
  'fs.replace-range': (params: PathParams) =>
    mutation({
      path: params.resolvedPath,
      replacedLines: 1,
      newTotalLines: 2,
      sha256: SHA256,
    }),
  'fs.delete-file': (params: PathParams) => mutation({ path: params.resolvedPath, deleted: true }),
  'fs.move-file': (params: { readonly resolvedFrom: string; readonly resolvedTo: string }) =>
    mutation({
      from: params.resolvedFrom,
      to: params.resolvedTo,
      moved: true,
    }),
  'fs.list-directory': (params: PathParams) => ({ path: params.resolvedPath, entries: [] }),
  'fs.glob': (params: { readonly pattern: string; readonly cwd: string }) => ({
    pattern: params.pattern,
    cwd: params.cwd,
    matches: [],
    truncated: false,
  }),
  'fs.grep': (params: { readonly pattern: string; readonly resolvedPath: string }) => ({
    pattern: params.pattern,
    path: params.resolvedPath,
    matches: [],
    filesScanned: 0,
    truncated: false,
  }),
  'fs.apply-patch': () =>
    mutation({
      files: [{ path: 'added.txt', op: 'add', sha256: SHA256 }],
      summary: '1 file changed',
    }),
};

/** Each answer, recording what arrived before it replies. */
function recordingHandlers(): Partial<Record<RuntimeMethod, TestHandler>> {
  return Object.fromEntries(
    Object.entries(ANSWERS).map(([method, answer]) => [
      method,
      (params: never) => {
        sent.set(method, params as { pathPolicy?: RuntimePathFilter });
        return answer(params);
      },
    ])
  );
}

/**
 * A Local runtime whose handlers record what arrived. The recording sits
 * behind the protocol rather than in front of the client, so what it captures
 * is what a remote peer would have received.
 */
function startRecordingRuntime(): void {
  sent = new Map();
  const manager = new RuntimeConnectionManager({
    resolveEnvironment: (userId) =>
      Promise.resolve({
        id: LOCAL_ENVIRONMENT_ID,
        userId,
        name: 'Local',
        transportKind: 'in-process' as const,
        config: {},
        enabled: true,
      }),
    connectors: {
      'in-process': async (_definition, onUnavailable) => {
        const definition = new FakeRuntimeDefinition({
          runtimeVersion: VERSION,
          manifest: { ...TEST_RUNTIME_MANIFEST, enforcesPathPolicy: true },
          consent: fixedConsent(RUNTIME_CONSENT_PRESETS.full, 'host'),
          handlers: recordingHandlers(),
        });
        const connection = await connectFakeRuntime(definition, { hubVersion: VERSION });
        return {
          client: new RuntimeClient(connection.hub, onUnavailable),
          close: () => connection.close(),
        };
      },
    },
  });

  setRuntimeConnectionManagerForTests(manager);
  release = async () => {
    await manager.closeAll();
    setRuntimeConnectionManagerForTests(undefined);
  };
}

/** A chat pinned to `workdir`, which is what makes a containment root apply. */
function restrictedContext(): ToolContext {
  return {
    userId: 'u1',
    chatId: 'c1',
    parameters: { allowedPaths: [], deniedPaths: [] },
    workdir,
    workdirPolicy: { root: workdir, restricted: true },
  };
}

function sentPolicy(method: string): RuntimePathFilter | undefined {
  const params = sent.get(method);
  if (!params) throw new Error(`The runtime never received a "${method}" call.`);
  return params.pathPolicy;
}

beforeEach(() => {
  startRecordingRuntime();
});

afterEach(async () => {
  await release();
});

describe('a restricted chat sends its containment root on every filesystem call', () => {
  it('read_file', async () => {
    await executeReadFile({ path: 'file.txt' }, restrictedContext());

    expect(sentPolicy('fs.read-file')?.containmentRoot).toBe(workdir);
  });

  it('write_file', async () => {
    await executeWriteFile({ path: 'new.txt', content: 'contents\n' }, restrictedContext());

    expect(sentPolicy('fs.write-file')?.containmentRoot).toBe(workdir);
  });

  it('create_file', async () => {
    await executeCreateFile({ path: 'created.txt', content: 'contents\n' }, restrictedContext());

    expect(sentPolicy('fs.create-file')?.containmentRoot).toBe(workdir);
  });

  it('edit_file', async () => {
    await executeEditFile(
      { path: 'file.txt', oldString: 'before', newString: 'after' },
      restrictedContext()
    );

    expect(sentPolicy('fs.edit-file')?.containmentRoot).toBe(workdir);
  });

  it('replace_range', async () => {
    await executeReplaceRange(
      { path: 'file.txt', startLine: 1, endLine: 1, content: 'uno\n' },
      restrictedContext()
    );

    expect(sentPolicy('fs.replace-range')?.containmentRoot).toBe(workdir);
  });

  it('delete_file', async () => {
    await executeDeleteFile({ path: 'file.txt' }, restrictedContext());

    expect(sentPolicy('fs.delete-file')?.containmentRoot).toBe(workdir);
  });

  it('move_file', async () => {
    await executeMoveFile({ from: 'file.txt', to: 'moved.txt' }, restrictedContext());

    expect(sentPolicy('fs.move-file')?.containmentRoot).toBe(workdir);
  });

  it('list_directory', async () => {
    await executeListDirectory({ path: 'nested' }, restrictedContext());

    expect(sentPolicy('fs.list-directory')?.containmentRoot).toBe(workdir);
  });

  it('glob', async () => {
    await executeGlob({ pattern: '*.txt' }, restrictedContext());

    expect(sentPolicy('fs.glob')?.containmentRoot).toBe(workdir);
  });

  it('grep', async () => {
    await executeGrep({ pattern: 'needle' }, restrictedContext());

    expect(sentPolicy('fs.grep')?.containmentRoot).toBe(workdir);
  });

  it('apply_patch', async () => {
    await executeApplyPatch(
      {
        patch: [
          '*** Begin Patch',
          '*** Add File: added.txt',
          '+contents',
          '*** End Patch',
          '',
        ].join('\n'),
      },
      restrictedContext()
    );

    expect(sentPolicy('fs.apply-patch')?.containmentRoot).toBe(workdir);
  });
});

describe('an unrestricted chat sends no containment root', () => {
  it('leaves the policy off entirely when nothing is configured', async () => {
    await executeReadFile(
      { path: 'file.txt' },
      { userId: 'u1', chatId: 'c1', parameters: {}, workdir }
    );

    expect(sentPolicy('fs.read-file')).toBeUndefined();
  });
});
