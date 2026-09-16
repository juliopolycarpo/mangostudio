/**
 * Builds the publishable package: one ESM bundle per entry with shared chunks,
 * declarations from tsc, and the spec's schema files copied beside them.
 *
 * @example
 * bun ./build.ts
 */

import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * Every subpath the package exports. A missing source fails the build, so a
 * release can never ship an exports map that points at nothing; pass
 * `--allow-missing` while a transport is still being written locally.
 */
const ENTRIES = ['index', 'stdio', 'ipc', 'in-process', 'ws', 'spawn', 'testing'] as const;
// A native path, not a URL pathname, so Windows does not see a leading slash.
const ROOT = fileURLToPath(new URL('.', import.meta.url));
const allowMissing = process.argv.includes('--allow-missing');

const entrypoints: string[] = [];
const missing: string[] = [];
for (const entry of ENTRIES) {
  const path = `${ROOT}src/${entry}.ts`;
  if (await Bun.file(path).exists()) entrypoints.push(path);
  else missing.push(entry);
}
if (missing.length > 0 && !allowMissing) {
  console.error(
    `entries without a source: ${missing.join(', ')}; expected every exported entry under src/, or pass --allow-missing`
  );
  process.exit(1);
}
for (const entry of missing) console.warn(`entry ${entry} has no source yet; skipping`);

await rm(`${ROOT}dist`, { recursive: true, force: true });
await rm(`${ROOT}schema`, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints,
  outdir: `${ROOT}dist`,
  target: 'node',
  format: 'esm',
  splitting: true,
  sourcemap: 'linked',
  external: ['typebox', 'typebox/*', 'bun:test'],
  naming: { entry: '[name].js', chunk: 'chunks/[name]-[hash].js' },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// `bun x` rather than a bare `bunx`, which Windows cannot spawn by name.
const declarations = Bun.spawnSync(
  [
    process.execPath,
    'x',
    'tsc',
    '-p',
    `${ROOT}tsconfig.build.json`,
    '--emitDeclarationOnly',
    '--declaration',
  ],
  { stdout: 'inherit', stderr: 'inherit' }
);
if (declarations.exitCode !== 0) process.exit(declarations.exitCode);

await mkdir(`${ROOT}schema/1`, { recursive: true });
await cp(`${ROOT}../../spec/schema/1`, `${ROOT}schema/1`, { recursive: true });
// npm ships only what `files` lists, and the licence lives at the repository root.
await cp(`${ROOT}../../LICENSE`, `${ROOT}LICENSE`);
process.stdout.write(
  `built ${entrypoints.length} entries into dist/ and copied the schema files\n`
);
