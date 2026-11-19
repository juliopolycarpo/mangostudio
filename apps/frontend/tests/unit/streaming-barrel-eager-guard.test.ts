/**
 * The frontend takes only types and `SSE_FRAME_MAX_CHARS` from the streaming
 * contract, so it must not import the `@mangostudio/shared/streaming` barrel at
 * runtime.
 *
 * The barrel re-exports the SSE chunk schemas, which build TypeBox objects (and
 * pull in the external-agent schemas) when the module evaluates. The package has
 * no `sideEffects` field, so the bundler keeps all of it even when one constant
 * is the only name used: about 10 KB of external-agent schemas plus the chunk
 * schemas sat in the entry chunk for a single number. `streaming/limits` carries
 * the constant alone; type imports are erased and stay free.
 */

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const FRONTEND_SRC = resolve(import.meta.dir, '../../src');
const STREAMING_BARREL = '@mangostudio/shared/streaming';
// `scanImports` reports only the imports that survive type erasure.
const scanners = {
  ts: new Bun.Transpiler({ loader: 'ts' }),
  tsx: new Bun.Transpiler({ loader: 'tsx' }),
};

function runtimeSpecifiers(file: string): string[] {
  const loader = file.endsWith('.tsx') ? 'tsx' : 'ts';
  return scanners[loader].scanImports(readFileSync(file, 'utf8')).map(({ path }) => path);
}

function streamingBarrelImporters(): string[] {
  return readdirSync(FRONTEND_SRC, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts') || entry.endsWith('.tsx'))
    .filter((entry) => runtimeSpecifiers(join(FRONTEND_SRC, entry)).includes(STREAMING_BARREL))
    .sort();
}

describe('frontend runtime imports of the streaming contract', () => {
  it('names the streaming barrel only in type-only imports', () => {
    expect(
      streamingBarrelImporters(),
      `expected no runtime import of ${STREAMING_BARREL} in apps/frontend/src (use \`import type\`, or ${STREAMING_BARREL}/limits for SSE_FRAME_MAX_CHARS)`
    ).toEqual([]);
  });

  it('sees a runtime import and ignores a type-only one', () => {
    // Guards the scan itself: a scanner that reported nothing would pass above.
    const source = `
      import type { StreamChunk } from '${STREAMING_BARREL}';
      import { type SSEDoneEvent } from '${STREAMING_BARREL}';
      import { StreamChunkSchema } from '${STREAMING_BARREL}';
    `;
    expect(scanners.ts.scanImports(source).map(({ path }) => path)).toEqual([STREAMING_BARREL]);
  });
});
