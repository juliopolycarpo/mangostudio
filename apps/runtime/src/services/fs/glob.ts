import { resolve } from 'node:path';
import { PathAccessError } from '../../errors';
import type { RuntimeGlobParams, RuntimeGlobResult } from '../../methods';
import { throwIfAborted } from '../cancellation';
import { compilePolicyGuard } from '../fs-path-policy';

export async function globRuntimePaths(
  params: RuntimeGlobParams,
  signal?: AbortSignal
): Promise<RuntimeGlobResult> {
  const matches: string[] = [];
  let truncated = false;
  const glob = new Bun.Glob(params.pattern);
  const allows = compilePolicyGuard(params.pathPolicy);

  try {
    for await (const match of glob.scan({
      cwd: params.cwd,
      dot: params.includeDotfiles,
      absolute: params.absolute,
      onlyFiles: false,
    })) {
      throwIfAborted(signal);
      if (!allows(resolve(params.cwd, match))) continue;
      if (matches.length >= params.maxResults) {
        truncated = true;
        break;
      }
      matches.push(match);
    }
  } catch (error) {
    if (error instanceof PathAccessError) throw error;
    // A cancelled walk is the hub's answer, not a pattern failure.
    if (error instanceof Error && error.name === 'AbortError') throw error;
    const message = error instanceof Error ? error.message : 'Failed to evaluate glob pattern';
    throw new PathAccessError(
      `Cannot evaluate pattern "${params.pattern}" in "${params.cwd}": ${message}`
    );
  }

  return {
    pattern: params.pattern,
    cwd: params.cwd,
    matches,
    truncated,
  };
}
