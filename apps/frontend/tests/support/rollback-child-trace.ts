import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const TRACE_BODY = `
import { appendFileSync as appendRollbackTrace } from 'node:fs';
function recordRollbackChildPhase(phase) {
  appendRollbackTrace(
    process.env.MANGO_TEST_ROLLBACK_CHILD_TRACE,
    JSON.stringify({ phase, pid: process.pid, at: performance.timeOrigin + performance.now() }) + '\\n',
  );
}
`;

/** Trace the test fixture's private compiler copy. Example: await traceRollbackBuild(frontend). */
export async function traceRollbackBuild(frontend: string): Promise<string> {
  const buildPath = join(frontend, 'build.ts');
  const preload = join(frontend, 'scripts', 'rollback-phase-preload.ts');
  const phases = [
    ['const ROOT = dirname(fileURLToPath(import.meta.url));', 'imports-loaded'],
    ['  await updateRouteTree({ force: production });', 'routes-start'],
    ['  const tailwind = createTailwindPlugin({ projectRoot: ROOT });', 'routes-end'],
    ['  await tailwind.prepare([', 'tailwind-prepare-start'],
    [
      "  const stagedDist = trackTempPath(await mkdtemp(join(ROOT, '.dist-staging-')));",
      'tailwind-prepare-end',
    ],
    ['    console.error(error);', 'build-error'],
  ] as const;
  let source = await readFile(buildPath, 'utf8');
  for (const [anchor, phase] of phases) {
    if (source.split(anchor).length !== 2) {
      throw new Error(
        `Rollback trace: expected one compiler phase ${phase} | received anchor ${anchor}`
      );
    }
    source = source.replace(
      anchor,
      `recordRollbackChildPhase(${JSON.stringify(phase)});\n${anchor}`
    );
  }
  const shebang = '#!/usr/bin/env bun\n';
  if (!source.startsWith(shebang)) {
    throw new Error(`Rollback trace: expected the Bun shebang at ${buildPath}`);
  }
  await writeFile(buildPath, `${shebang}${TRACE_BODY}${source.slice(shebang.length)}`);
  await writeFile(preload, `${TRACE_BODY}\nrecordRollbackChildPhase('preload');\n`);
  return preload;
}
