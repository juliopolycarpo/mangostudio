/**
 * The frontend takes only types and `SSE_FRAME_MAX_CHARS` from the streaming
 * contract, so it must not import the `@mangostudio/shared/streaming` barrel at
 * runtime.
 *
 * The barrel re-exports the SSE chunk schemas, which build TypeBox objects (and
 * pull in the external-agent schemas) when the module evaluates. A bundler can
 * drop a module nothing uses (the shared package declares its `sideEffects`),
 * but it cannot drop the schemas in a module that also holds a constant the
 * frontend does use. `streaming/limits` carries the constant alone; type imports
 * are erased and stay free.
 *
 * `GIT_BATCH_STATE_MAX_CHAT_IDS` follows the same rule through `git/limits`:
 * the git barrel stays importable for its parser and prompt, but not for that
 * number, which used to sit beside the request schemas.
 */

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const FRONTEND_SRC = resolve(import.meta.dir, '../../src');
const STREAMING_BARREL = '@mangostudio/shared/streaming';
const GIT_BARREL = '@mangostudio/shared/git';
// `scanImports` reports only the imports that survive type erasure.
const scanners = {
  ts: new Bun.Transpiler({ loader: 'ts' }),
  tsx: new Bun.Transpiler({ loader: 'tsx' }),
};

function runtimeSpecifiers(file: string): string[] {
  const loader = file.endsWith('.tsx') ? 'tsx' : 'ts';
  return scanners[loader].scanImports(readFileSync(file, 'utf8')).map(({ path }) => path);
}

function frontendSources(): string[] {
  return readdirSync(FRONTEND_SRC, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts') || entry.endsWith('.tsx'))
    .sort();
}

function streamingBarrelImporters(): string[] {
  return frontendSources().filter((entry) =>
    runtimeSpecifiers(join(FRONTEND_SRC, entry)).includes(STREAMING_BARREL)
  );
}

/**
 * Names a source imports as values (not `import type`, not `{ type X }`) from one
 * module. The formatter writes named imports as `import { a, type B } from '…'`,
 * so a pattern over that shape is enough; the scan's own test pins the cases.
 */
function valueNamesImportedFrom(source: string, moduleSpecifier: string): string[] {
  const escaped = moduleSpecifier.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const statement = new RegExp(
    `import\\s+(type\\s+)?\\{([^}]*)\\}\\s+from\\s+['"]${escaped}['"]`,
    'g'
  );
  const names: string[] = [];
  for (const [, typeOnlyStatement, specifiers] of source.matchAll(statement)) {
    if (typeOnlyStatement || !specifiers) continue;
    for (const specifier of specifiers.split(',')) {
      const trimmed = specifier.trim();
      if (trimmed === '' || trimmed.startsWith('type ')) continue;
      names.push(trimmed.split(/\s+as\s+/)[0] ?? trimmed);
    }
  }
  return names;
}

function gitBatchBoundImporters(): string[] {
  return frontendSources().filter((entry) =>
    valueNamesImportedFrom(readFileSync(join(FRONTEND_SRC, entry), 'utf8'), GIT_BARREL).includes(
      'GIT_BATCH_STATE_MAX_CHAT_IDS'
    )
  );
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

describe('frontend runtime imports of the git contract', () => {
  it('takes GIT_BATCH_STATE_MAX_CHAT_IDS from git/limits, not the barrel', () => {
    expect(
      gitBatchBoundImporters(),
      `expected no value import of GIT_BATCH_STATE_MAX_CHAT_IDS from ${GIT_BARREL} in apps/frontend/src (use ${GIT_BARREL}/limits)`
    ).toEqual([]);
  });

  it('finds a value import and ignores type-only ones and other modules', () => {
    const source = `
      import { type GitSummary, parseGitDiff } from '${GIT_BARREL}';
      import type { GIT_BATCH_STATE_MAX_CHAT_IDS as TypeOnlyAlias } from '${GIT_BARREL}';
      import { type GIT_BATCH_STATE_MAX_CHAT_IDS } from '${GIT_BARREL}';
      import { GIT_BATCH_STATE_MAX_CHAT_IDS as Bound } from '${GIT_BARREL}/limits';
    `;
    expect(valueNamesImportedFrom(source, GIT_BARREL)).toEqual(['parseGitDiff']);
    expect(
      valueNamesImportedFrom(
        `import { GIT_BATCH_STATE_MAX_CHAT_IDS as Bound } from '${GIT_BARREL}';`,
        GIT_BARREL
      )
    ).toEqual(['GIT_BATCH_STATE_MAX_CHAT_IDS']);
  });
});
