#!/usr/bin/env bun

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';

/** Bundle smoke dependencies for consumers without an install. Example: await bundleBinarySmoke(). */
export async function bundleBinarySmoke(rootDir = ROOT_DIR): Promise<string> {
  const outputDir = join(rootDir, '.mango', 'smoke');
  await mkdir(outputDir, { recursive: true });
  const result = await Bun.build({
    entrypoints: [join(rootDir, 'scripts', 'test-build.ts')],
    outdir: outputDir,
    naming: 'test-build.mjs',
    target: 'bun',
    format: 'esm',
    packages: 'bundle',
    sourcemap: 'none',
  });
  if (!result.success) {
    throw new AggregateError(
      result.logs,
      'Binary smoke harness: expected a bundled Bun ESM entrypoint'
    );
  }
  return join(outputDir, 'test-build.mjs');
}

if (import.meta.main) {
  console.log(await bundleBinarySmoke());
}
