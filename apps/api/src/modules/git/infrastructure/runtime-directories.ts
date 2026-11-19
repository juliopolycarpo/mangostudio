import { RemoteError, RESERVED_ERROR_CODES } from '@mangostudio/protocol';
import { mapWithConcurrency } from '@mangostudio/shared/utils/concurrency';

import { getRuntimeClient } from '../../../services/runtime-client';
import type { GitRuntimeSelection } from './git-cli';

// Each lookup is one cheap `canonicalize` on the runtime, but a user can have a
// long list of chats; a bound keeps one worktree list from flooding the link.
const RESOLVE_CONCURRENCY = 8;

/**
 * The reserved codes that say the runtime could not be asked, as opposed to the
 * runtime answering that it failed on one directory. Every other code a
 * `workspace.validate` call can carry (`INTERNAL` for ELOOP, ESTALE, EIO,
 * ENAMETOOLONG, ...) belongs to the directory it was asked about.
 */
const TRANSPORT_FAILURE_CODES: ReadonlySet<string> = new Set([
  RESERVED_ERROR_CODES.UNAVAILABLE,
  RESERVED_ERROR_CODES.CANCELLED,
  RESERVED_ERROR_CODES.TIMEOUT,
  RESERVED_ERROR_CODES.PROTOCOL_MISMATCH,
]);

type RuntimeClientHandle = Awaited<ReturnType<typeof getRuntimeClient>>;

/** Resolves directories to the spellings a comparison should try; see {@link createDirectorySpellingResolver}. */
export interface DirectorySpellingResolver {
  resolve(directories: readonly string[]): Promise<ReadonlyMap<string, readonly string[]>>;
}

/**
 * Where the runtime's filesystem says each directory really is, for one request.
 *
 * The runtime's `workspace.validate` canonicalizes an existing directory:
 * symlinks followed, and the casing the volume stores on a case-insensitive one.
 * That is the same function that produced a chat's stored workdir when it was
 * bound, and a fact about the machine that owns the directory, so the hub never
 * asks its own filesystem.
 *
 * `resolve` maps each input to the spellings both sides of a comparison should
 * try: the input as written, plus its canonical form when it differs. A
 * directory with no canonical form resolves to the input alone, as written, and
 * is compared lexically. That covers a directory that does not exist, one the
 * runtime rejects, and one the runtime fails on (a loop of symlinks, a stale
 * mount, an I/O error): the runtime has nothing to say about that one path, and
 * one broken workdir must not fail every list, add and remove of every chat
 * that shares the machine.
 *
 * What it does not swallow is the runtime being unreachable, a lookup timing
 * out, or the request being aborted. Those say nothing about a directory, and
 * guessing "unresolved" would let a removal go ahead on an answer nobody got.
 *
 * One request per distinct path for the resolver's whole life, not per call or
 * per occurrence, and a bounded number in flight. A request that reads two
 * worktree lists (a removal reads it twice, the second under the repository
 * lock) pays for each path once. The runtime has no batch form of this call,
 * and adding one would be a protocol change for a lookup that costs one
 * `canonicalize`.
 *
 * `signal` is handed to every call and also raced against it: aborting rejects
 * at once, even when a hung mount keeps the runtime from answering the cancel.
 * A lookup that has not started when the signal fires never starts.
 *
 * @example
 * const resolver = createDirectorySpellingResolver(selection, request.signal);
 * const resolved = await resolver.resolve(['/tmp/x/wt']);
 * resolved.get('/tmp/x/wt'); // ['/tmp/x/wt', '/private/tmp/x/wt']
 */
export function createDirectorySpellingResolver(
  selection: GitRuntimeSelection,
  signal?: AbortSignal
): DirectorySpellingResolver {
  let runtime: Promise<RuntimeClientHandle> | undefined;
  const lookups = new Map<string, Promise<readonly string[]>>();

  const lookup = (directory: string): Promise<readonly string[]> => {
    let pending = lookups.get(directory);
    if (pending === undefined) {
      pending = (async () => {
        signal?.throwIfAborted();
        runtime ??= getRuntimeClient(selection.userId, selection.environmentId);
        const client = await rejectOnAbort(runtime, signal);
        const canonical = await canonicalDirectoryOrNull(client, directory, signal);
        return canonical === null ? [directory] : [directory, canonical];
      })();
      lookups.set(directory, pending);
    }
    return pending;
  };

  return {
    async resolve(directories) {
      const distinct = [...new Set(directories)];
      const resolved = await mapWithConcurrency(
        distinct,
        RESOLVE_CONCURRENCY,
        async (directory) => [directory, await lookup(directory)] as const
      );
      return new Map(resolved);
    },
  };
}

async function canonicalDirectoryOrNull(
  runtime: RuntimeClientHandle,
  directory: string,
  signal: AbortSignal | undefined
): Promise<string | null> {
  try {
    const result = await rejectOnAbort(
      runtime.workspace.validate({ path: directory }, { signal }),
      signal
    );
    return result.ok ? result.resolvedPath : null;
  } catch (error) {
    // Only a failure the runtime reports about this one directory leaves it
    // unresolved. An abort, a timeout, or a runtime that cannot be reached is the
    // request's failure and goes up unchanged.
    if (error instanceof RemoteError && !TRANSPORT_FAILURE_CODES.has(error.code)) return null;
    throw error;
  }
}

/** Settles with `promise`, or rejects with the signal's reason the moment it aborts. */
function rejectOnAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
