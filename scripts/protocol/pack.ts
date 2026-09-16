/**
 * Packs the publishable `@mangostudio/protocol` tarball.
 *
 * `npm pack` cannot be run in `packages/protocol` directly: the workspace
 * manifest's `exports` points at `src/`, which the tarball does not ship, and
 * npm does not apply the `publishConfig.exports` override that would fix it
 * (measured on npm 11.19.0 — see `package-contents.ts`). So the package is
 * staged into a directory whose manifest already carries the published map, and
 * packed there. The same shape `scripts/release/pack-npm.ts` uses for the CLI.
 *
 * Prints the tarball path on the last line of stdout, so a caller can read it.
 *
 * @example
 * bun ./scripts/protocol/pack.ts --out .mango/out/protocol
 */

import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import { fatal, info, parseArgs, runCommand } from '../lib/runner';
import { type ProtocolManifest, publishedManifest } from './package-contents';

const PACKAGE_DIR = join(ROOT_DIR, 'packages', 'protocol');
const DEFAULT_OUT = join(ROOT_DIR, '.mango', 'out', 'protocol');

/** Everything `files` may name, plus the manifest this script rewrites. */
const STAGED_ENTRIES = ['dist', 'schema', 'README.md', 'LICENSE'] as const;

const { values } = parseArgs({ valueFlags: ['--out'] });
const outDir = values['--out'] ? join(ROOT_DIR, values['--out']) : DEFAULT_OUT;
const stageDir = join(outDir, 'package');

const build = await runCommand('protocol:build', ['bun', './build.ts'], { cwd: PACKAGE_DIR });
if (build.exitCode !== 0) process.exit(build.exitCode);

await rm(outDir, { recursive: true, force: true });
await mkdir(stageDir, { recursive: true });

const manifest = (await Bun.file(join(PACKAGE_DIR, 'package.json')).json()) as ProtocolManifest;
let staged: Record<string, unknown>;
try {
  staged = publishedManifest(manifest);
} catch (caught) {
  fatal(caught instanceof Error ? caught.message : String(caught));
}
await Bun.write(join(stageDir, 'package.json'), `${JSON.stringify(staged, null, 2)}\n`);

for (const entry of STAGED_ENTRIES) {
  const source = join(PACKAGE_DIR, entry);
  // `build.ts` refuses to finish without dist/, schema/ and LICENSE, so a
  // missing entry here means `files` names something the build never produced.
  if (!(await Bun.file(source).exists()) && !(await directoryExists(source))) {
    fatal(
      `packages/protocol/${entry} does not exist; "files" names it but the build produced nothing.`
    );
  }
  await cp(source, join(stageDir, entry), { recursive: true });
}

const pack = await runCommand(
  'npm pack',
  ['npm', 'pack', '--pack-destination', outDir, '--ignore-scripts', '--silent'],
  { cwd: stageDir }
);
if (pack.exitCode !== 0) process.exit(pack.exitCode);

const tarball = (await readdir(outDir)).find((entry) => entry.endsWith('.tgz'));
if (!tarball) fatal(`npm pack wrote no tarball into ${outDir}; expected one *.tgz.`);

info(`staged ${manifest.name}@${manifest.version} in ${stageDir}`);
console.log(join(outDir, tarball));

/** `Bun.file().exists()` answers false for a directory; `readdir` is the probe. */
async function directoryExists(path: string): Promise<boolean> {
  try {
    await readdir(path);
    return true;
  } catch {
    return false;
  }
}
