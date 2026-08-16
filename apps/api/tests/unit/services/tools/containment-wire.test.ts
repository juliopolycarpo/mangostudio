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
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  connectInProcessRuntime,
  createLocalRuntimeManifest,
  createRuntimeMethodHandlers,
  RuntimeHost,
  type RuntimeMethodHandler,
} from '@mangostudio/runtime';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import type { RuntimePathFilter } from '@mangostudio/shared/runtime-protocol';
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
import { clearFileFreshness } from '../../../../src/services/tools/file-freshness';
import type { ToolContext } from '../../../../src/services/tools/types';

const VERSION = 'test';

/** Params the runtime saw, by method, for the most recent call to each. */
type SentParams = Map<string, { readonly pathPolicy?: RuntimePathFilter }>;

let workdir: string;
let sent: SentParams;
let release: () => Promise<void>;

/**
 * A Local runtime whose handlers record what arrived before doing the work.
 * The recording sits behind the protocol rather than in front of the client, so
 * what it captures is what a remote peer would have received.
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
        let host: RuntimeHost | undefined;
        const registry = createRuntimeMethodHandlers({
          runtimeVersion: VERSION,
          emit: (event) => host?.emit(event),
        });
        const handlers = new Map<string, RuntimeMethodHandler>();
        for (const [method, handle] of registry.handlers) {
          handlers.set(method, (params, context) => {
            sent.set(method, params as { pathPolicy?: RuntimePathFilter });
            return handle(params, context);
          });
        }
        host = new RuntimeHost({
          runtimeVersion: VERSION,
          manifest: createLocalRuntimeManifest(),
          handlers,
          onClose: () => void registry.close(),
        });
        const connection = await connectInProcessRuntime(host, { hubVersion: VERSION });
        return {
          client: new RuntimeClient(connection.client, onUnavailable),
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
  clearFileFreshness();
  // Realpath'd because macOS hands back a symlinked temp dir, and the hub sends
  // the workdir it was given: comparing against the un-resolved form would fail
  // there for a reason that has nothing to do with what is being tested.
  workdir = realpathSync(mkdtempSync(join(tmpdir(), 'containment-wire-')));
  startRecordingRuntime();
});

afterEach(async () => {
  clearFileFreshness();
  await release();
  rmSync(workdir, { recursive: true, force: true });
});

describe('a restricted chat sends its containment root on every filesystem call', () => {
  it('read_file', async () => {
    await Bun.write(join(workdir, 'file.txt'), 'contents\n');

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
    const context = restrictedContext();
    await Bun.write(join(workdir, 'file.txt'), 'before\n');
    await executeReadFile({ path: 'file.txt' }, context);

    await executeEditFile({ path: 'file.txt', oldString: 'before', newString: 'after' }, context);

    expect(sentPolicy('fs.edit-file')?.containmentRoot).toBe(workdir);
  });

  it('replace_range', async () => {
    const context = restrictedContext();
    await Bun.write(join(workdir, 'file.txt'), 'one\ntwo\n');
    await executeReadFile({ path: 'file.txt' }, context);

    await executeReplaceRange(
      { path: 'file.txt', startLine: 1, endLine: 1, content: 'uno\n' },
      context
    );

    expect(sentPolicy('fs.replace-range')?.containmentRoot).toBe(workdir);
  });

  it('delete_file', async () => {
    const context = restrictedContext();
    await Bun.write(join(workdir, 'file.txt'), 'contents\n');
    await executeReadFile({ path: 'file.txt' }, context);

    await executeDeleteFile({ path: 'file.txt' }, context);

    expect(sentPolicy('fs.delete-file')?.containmentRoot).toBe(workdir);
  });

  it('move_file', async () => {
    await Bun.write(join(workdir, 'file.txt'), 'contents\n');

    await executeMoveFile({ from: 'file.txt', to: 'moved.txt' }, restrictedContext());

    expect(sentPolicy('fs.move-file')?.containmentRoot).toBe(workdir);
  });

  it('list_directory', async () => {
    mkdirSync(join(workdir, 'nested'), { recursive: true });

    await executeListDirectory({ path: 'nested' }, restrictedContext());

    expect(sentPolicy('fs.list-directory')?.containmentRoot).toBe(workdir);
  });

  it('glob', async () => {
    await executeGlob({ pattern: '*.txt' }, restrictedContext());

    expect(sentPolicy('fs.glob')?.containmentRoot).toBe(workdir);
  });

  it('grep', async () => {
    await Bun.write(join(workdir, 'file.txt'), 'needle\n');

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
    await Bun.write(join(workdir, 'file.txt'), 'contents\n');

    await executeReadFile(
      { path: 'file.txt' },
      { userId: 'u1', chatId: 'c1', parameters: {}, workdir }
    );

    expect(sentPolicy('fs.read-file')).toBeUndefined();
  });
});
