// Frontend bundle stats: measures raw + gzip bytes per asset type from a dist
// directory (CI artifact or local build).

import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { distFilePath, listDistFiles } from '@mangostudio/shared/utils/dist-files';
import { ROOT_DIR } from '../../lib/config';
import { runCapture } from './support';
import type { BundleStats } from './types';

const FRONTEND_DIST_DIR = join(ROOT_DIR, 'apps/frontend/dist');
const BUNDLE_EXTENSIONS = new Set(['.css', '.html', '.js']);

export interface BundleCollectorDeps {
  buildFrontend: () => Promise<string>;
}

const defaultBuildFrontend = async (): Promise<string> => {
  const build = await runCapture(['bun', 'run', '--filter', '@mangostudio/frontend', 'build']);
  if (build.exitCode !== 0) {
    throw new Error(`frontend build failed: ${build.stderr || build.stdout}`.slice(0, 1_000));
  }
  return FRONTEND_DIST_DIR;
};

const defaultDeps: BundleCollectorDeps = {
  buildFrontend: defaultBuildFrontend,
};

const assertDistUsable = async (distDir: string): Promise<void> => {
  if (!existsSync(distDir)) {
    throw new Error(`QA_FRONTEND_DIST is set but missing: ${distDir}`);
  }
  const entries = await readdir(distDir);
  if (entries.length === 0) {
    throw new Error(`QA_FRONTEND_DIST is set but empty: ${distDir}`);
  }
};

const resolveDistDir = async (deps: BundleCollectorDeps): Promise<string> => {
  const provided = process.env.QA_FRONTEND_DIST?.trim();
  if (provided) {
    await assertDistUsable(provided);
    return provided;
  }
  return deps.buildFrontend();
};

const measureDist = async (distDir: string): Promise<BundleStats> => {
  const paths = listDistFiles(distDir).filter((path) => BUNDLE_EXTENSIONS.has(extname(path)));
  let rawBytes = 0;
  let gzipBytes = 0;
  let jsGzipBytes = 0;
  let cssGzipBytes = 0;
  let htmlGzipBytes = 0;

  for (const path of paths) {
    const bytes = new Uint8Array(await Bun.file(distFilePath(distDir, path)).arrayBuffer());
    const compressedBytes = Bun.gzipSync(bytes).byteLength;
    rawBytes += bytes.byteLength;
    gzipBytes += compressedBytes;
    if (path.endsWith('.js')) jsGzipBytes += compressedBytes;
    else if (path.endsWith('.css')) cssGzipBytes += compressedBytes;
    else if (path.endsWith('.html')) htmlGzipBytes += compressedBytes;
  }

  return {
    files: paths.length,
    rawBytes,
    gzipBytes,
    jsGzipBytes,
    cssGzipBytes,
    htmlGzipBytes,
  };
};

/**
 * Measure a frontend dist directory. CI passes the artifact the build job
 * produced (QA_FRONTEND_DIST) so the report describes the bytes CI accepted;
 * local runs fall back to building, which keeps `bun ./scripts/qa-gate/collect.ts`
 * working on a dev machine.
 */
export const collectFrontendBundle = async (
  deps: BundleCollectorDeps = defaultDeps
): Promise<BundleStats> => {
  const distDir = await resolveDistDir(deps);
  return measureDist(distDir);
};
