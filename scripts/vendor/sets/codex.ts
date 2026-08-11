/**
 * The Codex `app-server` contract, produced by the vendor's own generator.
 *
 * The only one of the three sets with a real generator, and the only one whose
 * capture needs no installed CLI at all: `bunx @openai/codex@<pinned>` resolves
 * the same published tarball on a runner with nothing installed as it does on a
 * laptop with Codex on `PATH`. That is what makes this pin a fact rather than a
 * claim, and it is deliberately unrelated to how a *user* installed Codex —
 * npm, Bun, Homebrew and a downloaded binary all work at runtime, because the
 * adapter resolves its executable through the runtime's scanner and never
 * through this script.
 *
 * Nothing under `protocol/` is formatted by Biome. Running the repository
 * formatter over vendor output would make every regeneration report a diff that
 * is ours rather than theirs.
 */

import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { captureCommand } from '../../lib/exec';
import type { CaptureOptions, VendorContractSet } from '../lib/contract-set';

const ROOT_DIR = join(import.meta.dir, '..', '..', '..');
const CODEX_DIR = join(ROOT_DIR, 'apps/runtime/src/services/external-agents/codex');
const PINNED_MODULE = join(CODEX_DIR, 'pinned.ts');

/**
 * Read out of the runtime module rather than duplicated here.
 *
 * A second copy of the version is a second thing to bump, and the failure it
 * produces — a contract regenerated from one version while the adapter gates on
 * another — is silent in exactly the way this script exists to prevent. It is
 * read as text rather than imported because `scripts/` is not a workspace that
 * may reach into `apps/runtime/src` by relative path.
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

/**
 * The spec this run generates from.
 *
 * `latest` is the drift job's question — did OpenAI ship something — and it is
 * deliberately not a pin. A diff against it is a signal to look, never a
 * failure, because a vendor releasing is not a MangoStudio defect.
 */
async function resolveSpec(options: CaptureOptions): Promise<string> {
  return options.latest
    ? `${(await readPinnedSpec()).split('@').slice(0, -1).join('@')}@latest`
    : readPinnedSpec();
}

export const codexContractSet: VendorContractSet = {
  id: 'codex-protocol',
  vendor: 'codex',
  command: 'bunx @openai/codex@<pinned> app-server generate-ts',
  artifactsDirectory: join(CODEX_DIR, 'protocol'),
  manifestDirectory: join(CODEX_DIR, 'contract'),
  perFileDigests: false,

  /**
   * The pinned package spec, not an installed binary's `--version`.
   *
   * This set is always capturable, so it never reports itself absent — which is
   * the honest answer, since `bunx` will fetch the tarball on a machine that has
   * never seen Codex.
   */
  resolveVersion(options) {
    return resolveSpec(options);
  },

  async capture(destination, options) {
    const spec = await resolveSpec(options);
    const result = await captureCommand(
      ['bunx', spec, 'app-server', 'generate-ts', '--out', destination],
      { cwd: ROOT_DIR }
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `bunx ${spec} app-server generate-ts failed with exit code ${result.exitCode}.\n${result.stderr.trim()}`
      );
    }
    // Nothing here needs credentials, so nothing here is ever partial.
    return {};
  },
};
