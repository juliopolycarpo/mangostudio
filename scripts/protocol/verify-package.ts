/**
 * Proves the published `@mangostudio/protocol` tarball: packs it, installs it
 * into a throwaway project, checks every file its published `exports` names is
 * actually in there, and imports every subpath it declares.
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

import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import { withTempDir } from '../lib/fs';
import { captureCommand, error, runCommand, success } from '../lib/runner';
import {
  exportTargets,
  type ProtocolManifest,
  publishedExports,
  publishedSubpaths,
} from './package-contents';

const PACKAGE_DIR = join(ROOT_DIR, 'packages', 'protocol');
const manifest = (await Bun.file(join(PACKAGE_DIR, 'package.json')).json()) as ProtocolManifest;

// The exit code travels back out of `withTempDir` rather than being taken inside
// it: `process.exit` terminates before any `finally` runs, so exiting from the
// body left the workdir — tarball, node_modules and all — behind on every
// failed run, and CI retries accumulated them.
process.exit(await withTempDir('mango-protocol-pack-', verifyPackage));

/** Pack the tarball, install it into a throwaway project, and resolve every published subpath. */
async function verifyPackage(workdir: string): Promise<number> {
  const packed = await captureCommand(
    ['bun', './scripts/protocol/pack.ts', '--out', '.mango/out/protocol'],
    {
      cwd: ROOT_DIR,
    }
  );
  if (packed.exitCode !== 0) {
    process.stderr.write(packed.stdout + packed.stderr);
    return packed.exitCode;
  }
  const tarball = packed.stdout.trim().split('\n').at(-1);
  if (!tarball?.endsWith('.tgz')) {
    error(
      `pack.ts printed no tarball path; last stdout line was ${JSON.stringify(tarball ?? '')}.`
    );
    return 1;
  }

  const project = join(workdir, 'consumer');
  await Bun.write(
    join(project, 'package.json'),
    `${JSON.stringify({ name: 'protocol-consumer', private: true, type: 'module' }, null, 2)}\n`
  );
  const install = await runCommand('install tarball', ['bun', 'add', tarball], { cwd: project });
  if (install.exitCode !== 0) return install.exitCode;

  const absent = await missingTargets(join(project, 'node_modules', ...manifest.name.split('/')));
  if (absent.length > 0) {
    error(
      `the published tarball declares ${absent.length} export target(s) it does not contain: ${absent.join(', ')}.`
    );
    return 1;
  }

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
  if (probed.exitCode !== 0) return probed.exitCode;
  success(`the published tarball resolves all ${specifiers.length} subpaths`);
  return 0;
}

/**
 * Export targets the installed package does not contain. The probe above only
 * exercises the condition a runtime `import()` picks — `default` — so a
 * `types` entry pointing at a declaration the build never emitted would resolve
 * fine here and fail in every consumer's editor. Wildcard targets are left to
 * the probe, which substitutes a real document into them.
 *
 * @example
 * await missingTargets('/tmp/x/node_modules/@mangostudio/protocol'); // []
 */
async function missingTargets(installed: string): Promise<string[]> {
  const targets = exportTargets(publishedExports(manifest)).filter(
    (target) => !target.includes('*')
  );
  const checked = await Promise.all(
    targets.map(async (target) => ({
      target,
      exists: await Bun.file(join(installed, target)).exists(),
    }))
  );
  return checked.filter((entry) => !entry.exists).map((entry) => entry.target);
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
