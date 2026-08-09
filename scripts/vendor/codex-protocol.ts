/**
 * Regenerates — or drift-checks — the vendored Codex `app-server` contract.
 *
 * The contract under `apps/runtime/src/services/external-agents/codex/protocol`
 * is emitted by the vendor's own generator and committed verbatim. Nothing in
 * it is hand-written, and nothing in it is formatted by Biome: running the
 * repository formatter over vendor output would make every regeneration report
 * a diff that is ours rather than theirs.
 *
 * Two modes:
 *
 *   bun run vendor:codex-protocol            regenerate in place
 *   bun run vendor:codex-protocol --check    fail if regeneration differs
 *
 * `--check` is what CI runs. On a version bump the resulting diff *is* the
 * changelog, which is the whole reason the output is committed rather than
 * generated during the build.
 *
 * The generator is invoked as a **pinned package**, never as a globally
 * installed binary: `bunx @openai/codex@<pinned>` resolves the same tarball on a
 * runner with no Codex installed as it does on a laptop with one, so the pin is
 * a fact rather than a claim. This is deliberately unrelated to how a *user*
 * installed Codex — npm, Bun, Homebrew and a downloaded binary all work at
 * runtime, because the adapter resolves the executable through the runtime's
 * own scanner and never through this script.
 */

import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { parseArgs } from '../lib/args';
import { captureCommand } from '../lib/exec';
import { error, info, success } from '../lib/log';

const ROOT_DIR = join(import.meta.dir, '..', '..');
const PROTOCOL_DIR = join(ROOT_DIR, 'apps/runtime/src/services/external-agents/codex/protocol');
const PINNED_MODULE = join(ROOT_DIR, 'apps/runtime/src/services/external-agents/codex/pinned.ts');

/**
 * Read out of the runtime module rather than duplicated here.
 *
 * A second copy of the version is a second thing to bump, and the failure it
 * produces — a contract regenerated from one version while the adapter gates on
 * another — is silent in exactly the way this script exists to prevent.
 */
async function readPinnedSpec(): Promise<string> {
  const source = await readFile(PINNED_MODULE, 'utf8');
  const name = /name:\s*'([^']+)'/.exec(source)?.[1];
  const version = /version:\s*'([^']+)'/.exec(source)?.[1];
  if (!name || !version) {
    throw new Error(
      `Could not read CODEX_PROTOCOL_PACKAGE from ${relative(ROOT_DIR, PINNED_MODULE)}.`
    );
  }
  return `${name}@${version}`;
}

async function generateInto(destination: string, spec: string): Promise<void> {
  const result = await captureCommand(
    ['bunx', spec, 'app-server', 'generate-ts', '--out', destination],
    { cwd: ROOT_DIR }
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `bunx ${spec} app-server generate-ts failed with exit code ${result.exitCode}.\n${result.stderr.trim()}`
    );
  }
}

/** Every generated file, path-relative and sorted, so two trees compare stably. */
async function readTree(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      files.set(relative(root, absolute), await readFile(absolute, 'utf8'));
    }
  };
  await walk(root);
  return files;
}

function summarizeDrift(
  committed: Map<string, string>,
  regenerated: Map<string, string>
): string[] {
  const drift: string[] = [];
  for (const [path, content] of regenerated) {
    const existing = committed.get(path);
    if (existing === undefined) drift.push(`added:    ${path}`);
    else if (existing !== content) drift.push(`changed:  ${path}`);
  }
  for (const path of committed.keys()) {
    if (!regenerated.has(path)) drift.push(`removed:  ${path}`);
  }
  return drift.sort();
}

async function main(): Promise<void> {
  const { flags, positional } = parseArgs({ booleanFlags: ['--check'] });
  if (flags['--help']) {
    console.log(
      'Usage: bun run vendor:codex-protocol [--check]\n\n' +
        '  (no flags)  regenerate the vendored Codex contract in place\n' +
        '  --check     regenerate into a temporary directory and fail on any difference'
    );
    return;
  }
  if (positional.length > 0) {
    error(`Unexpected argument: ${positional[0]}`);
    process.exitCode = 1;
    return;
  }

  const spec = await readPinnedSpec();
  const staging = await mkdtemp(join(tmpdir(), 'codex-protocol-'));
  try {
    info(`Generating the Codex app-server contract from ${spec}…`);
    await generateInto(staging, spec);
    const regenerated = await readTree(staging);
    if (regenerated.size === 0) {
      throw new Error(`${spec} produced no TypeScript output.`);
    }

    if (!flags['--check']) {
      await rm(PROTOCOL_DIR, { recursive: true, force: true });
      await cp(staging, PROTOCOL_DIR, { recursive: true });
      success(`Regenerated ${regenerated.size} files into ${relative(ROOT_DIR, PROTOCOL_DIR)}.`);
      return;
    }

    const committed = await readTree(PROTOCOL_DIR);
    const drift = summarizeDrift(committed, regenerated);
    if (drift.length > 0) {
      error(
        `The vendored Codex contract is out of date with ${spec}.\n${drift.join('\n')}\n\n` +
          'Run `bun run vendor:codex-protocol` and commit the result. On a version bump the diff is the changelog.'
      );
      process.exitCode = 1;
      return;
    }
    success(`Vendored Codex contract matches ${spec} (${committed.size} files).`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

await main();
