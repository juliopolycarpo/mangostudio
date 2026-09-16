/**
 * Proves the published `@mangostudio/protocol` tarball: packs it, installs it
 * into a throwaway project, and imports every subpath its published `exports`
 * declares.
 *
 * The workspace resolves this package from `src/` and the tarball from `dist/`
 * (see `packages/protocol/AGENTS.md`), so the published map, the `files` list
 * and the build output that satisfies them are exercised nowhere else in the
 * repository. Without this lane, a `files` entry dropped or a subpath added
 * without a build would first be noticed by an installing consumer.
 *
 * @example
 * bun ./scripts/protocol/verify-package.ts
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import { captureCommand, fatal, runCommand, success } from '../lib/runner';
import { type ProtocolManifest, publishedSubpaths } from './package-contents';

const PACKAGE_DIR = join(ROOT_DIR, 'packages', 'protocol');
const manifest = (await Bun.file(join(PACKAGE_DIR, 'package.json')).json()) as ProtocolManifest;

const workdir = await mkdtemp(join(tmpdir(), 'mango-protocol-pack-'));
try {
  const packed = await captureCommand(
    ['bun', './scripts/protocol/pack.ts', '--out', '.mango/out/protocol'],
    {
      cwd: ROOT_DIR,
    }
  );
  if (packed.exitCode !== 0) {
    process.stderr.write(packed.stdout + packed.stderr);
    process.exit(packed.exitCode);
  }
  const tarball = packed.stdout.trim().split('\n').at(-1);
  if (!tarball?.endsWith('.tgz')) {
    fatal(
      `pack.ts printed no tarball path; last stdout line was ${JSON.stringify(tarball ?? '')}.`
    );
  }

  const project = join(workdir, 'consumer');
  await Bun.write(
    join(project, 'package.json'),
    `${JSON.stringify({ name: 'protocol-consumer', private: true, type: 'module' }, null, 2)}\n`
  );
  const install = await runCommand('install tarball', ['bun', 'add', tarball], { cwd: project });
  if (install.exitCode !== 0) process.exit(install.exitCode);

  // One process resolving every subpath, so a failure names the subpath instead
  // of aborting the lane on the first import.
  const subpaths = publishedSubpaths(manifest);
  const specifiers = subpaths.map((subpath) =>
    subpath === '.'
      ? manifest.name
      : // A wildcard subpath such as `./schema/*` is probed against a document
        // the spec actually has. `replaceAll`, not `replace`: the latter
        // substitutes only the first `*`, which would silently probe a
        // half-resolved specifier if a subpath ever carried two.
        `${manifest.name}/${subpath.slice(2).replaceAll('*', '1/protocol.json')}`
  );
  await Bun.write(join(project, 'probe.mjs'), probeSource(specifiers));

  const probed = await runCommand('resolve subpaths', ['bun', 'run', 'probe.mjs'], {
    cwd: project,
  });
  if (probed.exitCode !== 0) process.exit(probed.exitCode);
  success(`the published tarball resolves all ${specifiers.length} subpaths`);
} finally {
  await rm(workdir, { recursive: true, force: true });
}

/** The consumer-side probe: import each specifier, collect every failure. */
function probeSource(specifiers: readonly string[]): string {
  const calls = specifiers.map((specifier) => `await check(${JSON.stringify(specifier)});`);
  return `const failures = [];
async function check(specifier) {
  try {
    const attributes = specifier.endsWith('.json') ? { with: { type: 'json' } } : undefined;
    const loaded = await import(specifier, attributes);
    if (loaded === null || typeof loaded !== 'object') {
      failures.push(\`\${specifier} resolved to \${typeof loaded}\`);
    }
  } catch (caught) {
    failures.push(\`\${specifier}: \${caught instanceof Error ? caught.message : String(caught)}\`);
  }
}
${calls.join('\n')}
if (failures.length > 0) {
  console.error(\`the published tarball does not resolve \${failures.length} subpath(s):\`);
  for (const failure of failures) console.error(\`  - \${failure}\`);
  process.exit(1);
}
`;
}
