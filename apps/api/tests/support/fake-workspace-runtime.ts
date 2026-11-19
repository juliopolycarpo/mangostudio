import type {
  RuntimeCapabilityManifest,
  RuntimeWorkspaceValidateResult,
} from '@mangostudio/shared/runtime-contract';

import type { RuntimeClient } from '../../src/services/runtime-client/runtime-client';
import {
  RuntimeConnectionManager,
  setRuntimeConnectionManagerForTests,
} from '../../src/services/runtime-client/runtime-connection-manager';
import { createTargetPaths } from '../../src/services/runtime-client/target-paths';

const POSIX_MANIFEST: RuntimeCapabilityManifest = {
  platform: 'linux',
  arch: 'x64',
  pathStyle: 'posix',
  homeDir: '/remote/home',
  shells: ['bash'],
  git: { available: true, version: '2.51.0' },
  features: {
    tools: true,
    git: true,
    probing: false,
    mcp: false,
    library: false,
    checkpoints: true,
  },
};

export interface FakeWorkspaceRuntime {
  /** Every path `workspace.validate` was asked about, in call order. */
  readonly validated: string[];
  /** The abort signal each `workspace.validate` call carried, in call order. */
  readonly signals: (AbortSignal | undefined)[];
  restore(): void;
}

export interface FakeWorkspaceRuntimeOptions {
  /**
   * Paths whose `workspace.validate` never settles and ignores its signal, like
   * a hung mount on a runtime that does not answer a cancel.
   */
  readonly hanging?: readonly string[];
}

/**
 * Installs a runtime whose `workspace.validate` answers from `answers`, keyed by
 * the path asked about; a path without an answer is reported as not found, as a
 * real runtime reports a directory that does not exist. A value that is an
 * `Error` is thrown instead: pass a `RemoteError('UNAVAILABLE', ...)` for a
 * transport failure, or a plain `RemoteError('INTERNAL', ...)` for the runtime
 * failing on one directory (ELOOP, EIO, ...).
 *
 * Only `workspace.validate` and the path rules are faked, because those are the
 * only runtime facts the callers under test read.
 *
 * @example
 * const runtime = installFakeWorkspaceRuntime({ '/tmp/x': '/private/tmp/x' });
 * // ... exercise the code ...
 * runtime.restore();
 */
export function installFakeWorkspaceRuntime(
  answers: Readonly<Record<string, string | Error>>,
  options: FakeWorkspaceRuntimeOptions = {}
): FakeWorkspaceRuntime {
  const validated: string[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const hanging = new Set(options.hanging);
  const client = {
    manifest: POSIX_MANIFEST,
    paths: createTargetPaths(POSIX_MANIFEST),
    workspace: {
      validate: (
        { path }: { path: string },
        requestOptions?: { signal?: AbortSignal }
      ): Promise<RuntimeWorkspaceValidateResult> => {
        validated.push(path);
        signals.push(requestOptions?.signal);
        if (hanging.has(path)) return new Promise(() => undefined);
        const answer = answers[path];
        if (answer instanceof Error) return Promise.reject(answer);
        return Promise.resolve(
          answer === undefined
            ? { ok: false, reason: 'not-found' }
            : { ok: true, resolvedPath: answer }
        );
      },
    },
  } as unknown as RuntimeClient;
  setRuntimeConnectionManagerForTests(
    new RuntimeConnectionManager({
      resolveEnvironment: (userId, environmentId) =>
        Promise.resolve({
          id: environmentId,
          userId,
          name: 'Fake',
          transportKind: 'stdio',
          config: {},
          enabled: true,
        }),
      connectors: {
        stdio: () => Promise.resolve({ client, close: () => undefined }),
      },
    })
  );
  return { validated, signals, restore: () => setRuntimeConnectionManagerForTests(undefined) };
}
