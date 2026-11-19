import { RemoteError } from '@mangostudio/protocol';
import { mapWithConcurrency } from '@mangostudio/shared/utils/concurrency';

import { getRuntimeClient } from '../../../services/runtime-client';
import type { GitRuntimeSelection } from './git-cli';

// Each lookup is one cheap `canonicalize` on the runtime, but a user can have a
// long list of chats; a bound keeps one worktree list from flooding the link.
const RESOLVE_CONCURRENCY = 8;

/**
 * Where the runtime's filesystem says each directory really is.
 *
 * The runtime's `workspace.validate` canonicalizes an existing directory:
 * symlinks followed, and the casing the volume stores on a case-insensitive one.
 * That is the same function that produced a chat's stored workdir when it was
 * bound, and a fact about the machine that owns the directory, so the hub never
 * asks its own filesystem.
 *
 * The result maps each input to the spellings both sides of a comparison should
 * try: the input as written, plus its canonical form when it differs. A
 * directory that does not exist resolves to the input alone; there is nothing
 * on disk to delete or to collide with.
 *
 * One request per distinct path, not per occurrence, and a bounded number in
 * flight. The runtime has no batch form of this call, and adding one would be a
 * protocol change for a lookup that costs one `canonicalize`.
 *
 * @example
 * const resolved = await resolveDirectorySpellings(['/tmp/x/wt'], selection);
 * resolved.get('/tmp/x/wt'); // ['/tmp/x/wt', '/private/tmp/x/wt']
 */
export async function resolveDirectorySpellings(
  directories: readonly string[],
  selection: GitRuntimeSelection
): Promise<ReadonlyMap<string, readonly string[]>> {
  const distinct = [...new Set(directories)];
  if (distinct.length === 0) return new Map();

  const runtime = await getRuntimeClient(selection.userId, selection.environmentId);
  const resolved = await mapWithConcurrency(distinct, RESOLVE_CONCURRENCY, async (directory) => {
    const canonical = await canonicalDirectoryOrNull(runtime, directory);
    return [directory, canonical === null ? [directory] : [directory, canonical]] as const;
  });
  return new Map(resolved);
}

async function canonicalDirectoryOrNull(
  runtime: Awaited<ReturnType<typeof getRuntimeClient>>,
  directory: string
): Promise<string | null> {
  try {
    const result = await runtime.workspace.validate({ path: directory });
    return result.ok ? result.resolvedPath : null;
  } catch (error) {
    // A stored workdir the runtime rejects outright (not a path it can read)
    // names nothing it could resolve. Anything else — an unreachable runtime, a
    // cancelled request — is the request's failure, not this directory's.
    if (error instanceof RemoteError && error.details?.kind === 'workdir_validation') return null;
    throw error;
  }
}
