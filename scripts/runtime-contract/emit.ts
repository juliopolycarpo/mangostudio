/**
 * Writes — or drift-checks — the contract artifacts a non-TypeScript runtime is
 * built against.
 *
 *   bun run contracts:emit          regenerate every artifact
 *   bun run contracts:check         fail when one is stale or hand-edited
 *
 * `contracts:check` runs inside `bun run check`, which is what makes the
 * committed files trustworthy: a method added to the contract without
 * regenerating them turns the gate red in the same pull request rather than
 * three releases later, when a peer built from a stale catalog starts refusing
 * calls nobody changed.
 *
 * Unlike `vendor-contracts:check`, this needs nothing but the repository — no
 * vendor binary, no network — so there is no reason to keep it out of the main
 * gate.
 *
 * The catalog is additionally validated against the published
 * `catalog.json` schema on every run, in both modes. Emitting a document the
 * protocol's own schema refuses is the one failure a byte comparison cannot
 * see, because a wrong catalog is stable too.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from '../lib/args';
import { error, info, success } from '../lib/log';
import { ARTIFACT_DIR, renderArtifacts } from './artifacts';
import { assertCatalogValid } from './validate';

const ROOT_DIR = join(import.meta.dir, '..', '..');

function printHelp(): never {
  console.log(`Usage: bun run contracts:emit [--check]

Writes the cross-language contract artifacts under ${ARTIFACT_DIR}.

  --check   Do not write. Exit non-zero when any artifact differs from what
            the contract would produce, naming the stale files.
  --help`);
  process.exit(0);
}

/** Committed text of one artifact, or null when the file is not there yet. */
async function readCommitted(path: string): Promise<string | null> {
  try {
    return await readFile(join(ROOT_DIR, path), 'utf8');
  } catch {
    return null;
  }
}

async function checkArtifacts(artifacts: ReadonlyMap<string, string>): Promise<void> {
  const stale: string[] = [];
  for (const [path, expected] of artifacts) {
    if ((await readCommitted(path)) !== expected) stale.push(path);
  }

  if (stale.length > 0) {
    error(
      `Contract artifacts are stale:\n${stale.map((path) => `  - ${path}`).join('\n')}\n` +
        'Run "bun run contracts:emit" and commit the result. These files are generated; editing one by hand is what this check exists to catch.'
    );
    process.exit(1);
  }

  success(`Contract artifacts up to date (${artifacts.size} files).`);
}

async function writeArtifacts(artifacts: ReadonlyMap<string, string>): Promise<void> {
  for (const [path, contents] of artifacts) {
    const absolute = join(ROOT_DIR, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, 'utf8');
    info(`  ${path}`);
  }
  success(`Wrote ${artifacts.size} contract artifacts.`);
}

const { flags } = parseArgs({ booleanFlags: ['--check'] });
if (flags['--help']) printHelp();

const artifacts = renderArtifacts();
await assertCatalogValid(artifacts);

if (flags['--check']) await checkArtifacts(artifacts);
else await writeArtifacts(artifacts);
