/**
 * Hub launch of a runtime inside a container (`transportKind: 'container'`).
 *
 * There is no seventh wire protocol here. The engine is spawned as a child, the
 * runtime runs inside the container on the far side of the pipe it opens, and
 * the stdio transport speaks through it unchanged — the same spawn, handshake
 * and teardown a WSL distribution goes through, with a different argv in front.
 *
 * What the container changes is the direction of protection. The consent model
 * cannot make `allow.shell` mean less than "everything a shell can reach"; a
 * container makes the reachable part small. The sandbox constrains the *agent*,
 * not the hub — the engine runs as the hub's own user and is host-root
 * equivalent, so this is isolation for the machine's files, not a boundary
 * against the person who configured it.
 *
 * Release equality still gates, unlike SSH: the binary in the container is this
 * hub's own, mounted from its own cache, so a mismatch means the resolution is
 * wrong rather than that a peer is running its own install.
 */

import { randomBytes } from 'node:crypto';
import { RuntimeRemoteError } from '@mangostudio/runtime';
import type { ContainerEngine, ContainerFailureReason } from '@mangostudio/shared/environments';
import {
  containerConfigRefusal,
  containerEngineOf,
  containerLaunchCommand,
  containerName,
  describeContainerMountRefusal,
} from '@mangostudio/shared/environments';
import { getVersion } from '../../lib/config';
import { createDiagnosticLogger } from '../../lib/logger';
import { throwIfAborted } from '../../modules/environments/domain/cancellation';
import {
  classifyContainerFailure,
  describeContainerFailure,
} from '../../modules/environments/domain/container-failure';
import {
  ContainerRuntimeSourceError,
  resolveContainerRuntimeBinary,
} from '../../modules/environments/domain/container-runtime-source';
import { environmentConfigFor } from '../../modules/environments/domain/environment-config';
import {
  ContainerEngineError,
  type ContainerEngineService,
  containerEngineService,
} from '../../modules/environments/infrastructure/container-engine';
import { RuntimeClient } from './runtime-client';
import { type RuntimeLaunchFailure, spawnRuntimeChild } from './spawn-runtime-child';

/**
 * Longer than a local spawn's five seconds: the engine has to create the
 * container, start an init, and run a binary off a bind mount before the first
 * frame. The image is already on disk by this point — the pull is its own
 * step — so this budgets a start, not a download.
 */
const HANDSHAKE_TIMEOUT_MS = 20_000;

const logger = createDiagnosticLogger('runtime-container');

/** Minimal definition shape — kept local to avoid a cycle with the manager. */
export interface ContainerRuntimeDefinition {
  readonly id: string;
  readonly config: unknown;
}

export interface ContainerRuntimeConnection {
  readonly client: RuntimeClient;
  close(): void | Promise<void>;
}

/**
 * Reports something the card has to name: a long phase to wait through, or a
 * launch that only worked because the hub fell back to its own cache.
 */
export type ContainerConnectProgress = (phase: 'pulling' | 'offline-cache') => void;

/**
 * What the attempt gives this launch. Structurally the manager's connect
 * context, kept local for the same reason {@link ContainerRuntimeDefinition}
 * is: this module must not import the manager back — the repo's circular-
 * dependency gate flags that pairing even when the import is type-only.
 */
export interface ContainerConnectContext {
  readonly report?: ContainerConnectProgress;
  /**
   * Aborted when the attempt is released. The image pull and the matching
   * runtime download can both outlive the click that started them; spawn is
   * still bounded by its handshake timeout, so this is rechecked before it
   * rather than threaded into it.
   */
  readonly signal?: AbortSignal;
}

export interface ConnectContainerRuntimeDeps {
  readonly engines: ContainerEngineService;
  readonly resolveRuntimeBinary: typeof resolveContainerRuntimeBinary;
  readonly spawn: typeof spawnRuntimeChild;
}

const defaultDeps: ConnectContainerRuntimeDeps = {
  engines: containerEngineService,
  resolveRuntimeBinary: resolveContainerRuntimeBinary,
  spawn: spawnRuntimeChild,
};

export async function connectContainerRuntime(
  definition: ContainerRuntimeDefinition,
  onUnavailable: () => void,
  context: ContainerConnectContext = {},
  overrides: Partial<ConnectContainerRuntimeDeps> = {}
): Promise<ContainerRuntimeConnection> {
  const deps = { ...defaultDeps, ...overrides };
  const report = context.report;
  const config = environmentConfigFor('container', definition.config);
  const engine = containerEngineOf(config);

  // Schema-valid but unlaunchable: a host path that is relative, carries its
  // own mount separator, or would hand the container the machine back. Refused
  // before the engine is touched, because the engine would happily do it.
  const refusal = containerConfigRefusal(config);
  if (refusal) {
    throw new RuntimeRemoteError(
      'RUNTIME_UNAVAILABLE',
      `Environment "${definition.id}" cannot be launched: ${describeContainerMountRefusal(refusal)}`
    );
  }

  const platformId = await withFailureReason(() =>
    deps.engines.prepare(config, {
      onPullStart: () => report?.('pulling'),
      signal: context.signal,
    })
  );
  throwIfAborted(context.signal, 'Container connection was cancelled.');
  const runtime = await withFailureReason(() =>
    deps.resolveRuntimeBinary(platformId, { signal: context.signal })
  );
  // The release could not be reached and the cache answered for it. The launch
  // is as verified as the day those bytes were downloaded, which is worth
  // saying: an operator otherwise has no way to tell it happened.
  if (runtime.offlineCache) report?.('offline-cache');

  // A fresh name per launch: a relaunch must not collide with a container the
  // engine has not finished reaping, and the backstop below has to be certain
  // it is killing this connection's container and not another chat's.
  const name = containerName(definition.id, randomBytes(4).toString('hex'));
  const launch = containerLaunchCommand({ config, name, runtimeBinaryPath: runtime.path });

  throwIfAborted(context.signal, 'Container connection was cancelled.');

  let failureReason: ContainerFailureReason = 'unknown';
  let connection: Awaited<ReturnType<typeof spawnRuntimeChild>>;
  try {
    connection = await deps.spawn({
      environmentId: definition.id,
      launch,
      hubVersion: getVersion(),
      handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
      describeFailure: (failure: RuntimeLaunchFailure) => {
        failureReason = classifyContainerFailure({
          stderr: failure.stderr,
          exitCode: failure.exitCode,
          spawnErrorCode: failure.spawnErrorCode,
        });
        // An unrecognised failure keeps the generic message, which already
        // carries the stderr tail: a protocol mismatch reported by a runtime
        // that did answer is described better there than by anything the
        // engine said about starting it.
        return failureReason === 'unknown'
          ? undefined
          : describeContainerFailure(failureReason, {
              engine,
              image: config.image,
              stderr: failure.stderr,
            });
      },
      onClosed: onUnavailable,
    });
  } catch (error) {
    // The engine may have created the container before the handshake failed,
    // and `--rm` only fires when it exits on its own.
    await killQuietly(deps.engines, engine, name);
    throw attachReason(error, failureReason);
  }

  return {
    client: new RuntimeClient(connection.client, onUnavailable, definition.id),
    close: async () => {
      await connection.close();
      // Closing the child's stdin ends the runtime, which ends the container,
      // which `--rm` removes — that is the ordinary path and this does nothing.
      // It exists for the other one: killing the engine's client process does
      // not stop the container it started, so without this a crashed hub would
      // leave one running per lost connection.
      await killQuietly(deps.engines, engine, name);
    },
  };
}

async function killQuietly(
  engines: ContainerEngineService,
  engine: ContainerEngine,
  name: string
): Promise<void> {
  try {
    await engines.kill(engine, name);
  } catch (error) {
    // Teardown must not turn into a second failure on a path that is already
    // unwinding; the container is almost always gone by now.
    logger.debug('kill_backstop_failed', {
      engine,
      name,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Runs a preparation step, turning its typed failure into a transport error
 * that carries the reason to the card.
 *
 * Only the reason travels. The engine is not attached: the manager's
 * `failureDetail` forwards the reason fields and nothing else, and both sides
 * already read the engine off the environment's own config — a second copy in
 * the details bag was carried to the card and dropped there.
 */
async function withFailureReason<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    if (error instanceof ContainerEngineError) {
      throw new RuntimeRemoteError('RUNTIME_UNAVAILABLE', error.message, {
        containerFailureReason: error.reason,
      });
    }
    if (error instanceof ContainerRuntimeSourceError) {
      throw new RuntimeRemoteError('RUNTIME_UNAVAILABLE', error.message, {
        containerFailureReason: 'runtime-unavailable' satisfies ContainerFailureReason,
      });
    }
    throw error;
  }
}

/**
 * Re-throws with the classified reason attached, keeping whatever typed code
 * the launch produced. `PROTOCOL_MISMATCH` in particular has to survive: the
 * manager latches on it, and a runtime too old to speak this protocol is not
 * fixed by retrying.
 */
function attachReason(error: unknown, reason: ContainerFailureReason): RuntimeRemoteError {
  if (reason === 'unknown' && error instanceof RuntimeRemoteError) return error;
  const code = error instanceof RuntimeRemoteError ? error.code : 'RUNTIME_UNAVAILABLE';
  const message = error instanceof Error ? error.message : String(error);
  return new RuntimeRemoteError(code, message, {
    ...(error instanceof RuntimeRemoteError ? error.details : {}),
    containerFailureReason: reason,
  });
}
