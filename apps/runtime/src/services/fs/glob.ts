import { resolve } from 'node:path';
import { PathAccessError } from '../../errors';
import type { RuntimeGlobParams, RuntimeGlobResult } from '../../methods';
import { isRuntimePathAllowed } from '../fs-utils';

export async function globRuntimePaths(params: RuntimeGlobParams): Promise<RuntimeGlobResult> {
  const matches: string[] = [];
  let truncated = false;
  const glob = new Bun.Glob(params.pattern);

  try {
    for await (const match of glob.scan({
      cwd: params.cwd,
      dot: params.includeDotfiles,
      absolute: params.absolute,
      onlyFiles: false,
    })) {
      if (!isRuntimePathAllowed(resolve(params.cwd, match), params)) continue;
      if (matches.length >= params.maxResults) {
        truncated = true;
        break;
      }
      matches.push(match);
    }
  } catch (error) {
    if (error instanceof PathAccessError) throw error;
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
