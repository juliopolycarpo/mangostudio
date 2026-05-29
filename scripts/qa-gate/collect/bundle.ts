// Frontend bundle stats: builds the frontend and measures raw + gzip bytes
// per asset type.

import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { ROOT_DIR } from '../../lib/config';
import { runCapture } from './support';
import type { BundleStats } from './types';

const FRONTEND_DIST_DIR = join(ROOT_DIR, 'apps/frontend/dist');
const BUNDLE_EXTENSIONS = new Set(['.css', '.html', '.js']);

const walkFiles = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? walkFiles(path) : Promise.resolve([path]);
    })
  );
  return nested.flat();
};

/** Build the frontend and total raw/gzip bytes for js/css/html assets. */
export const collectFrontendBundle = async (): Promise<BundleStats> => {
  const build = await runCapture(['bun', 'run', '--filter', '@mangostudio/frontend', 'build']);
  if (build.exitCode !== 0) {
    throw new Error(`frontend build failed: ${build.stderr || build.stdout}`.slice(0, 1_000));
  }

  const files = (await walkFiles(FRONTEND_DIST_DIR)).filter((path) =>
    BUNDLE_EXTENSIONS.has(extname(path))
  );
  let rawBytes = 0;
  let gzipBytes = 0;
  let jsGzipBytes = 0;
  let cssGzipBytes = 0;
  let htmlGzipBytes = 0;

  for (const path of files) {
    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
    const compressedBytes = Bun.gzipSync(bytes).byteLength;
    rawBytes += bytes.byteLength;
    gzipBytes += compressedBytes;
    if (path.endsWith('.js')) jsGzipBytes += compressedBytes;
    else if (path.endsWith('.css')) cssGzipBytes += compressedBytes;
    else if (path.endsWith('.html')) htmlGzipBytes += compressedBytes;
  }

  return {
    files: files.length,
    rawBytes,
    gzipBytes,
    jsGzipBytes,
    cssGzipBytes,
    htmlGzipBytes,
  };
};
