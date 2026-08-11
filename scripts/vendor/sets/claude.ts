/**
 * The Claude Code CLI contract, captured from `--help` and `auth status`.
 *
 * No generator and no handshake, so the contract is the CLI's own description
 * of itself. Two artifacts, and each is here because an adapter reads it:
 *
 * | Artifact            | What the adapter reads off it                          |
 * | ------------------- | ------------------------------------------------------ |
 * | `cli-surface.json`  | the flags every turn's argv names, and `--permission-mode`'s choices |
 * | `auth-status.json`  | the fields `parseClaudeAuthStatus` narrows to           |
 *
 * `cli-surface.json` keeps its **values**, because here the values *are* the
 * contract: a permission mode is a string this adapter passes on a command
 * line, and a flag list reduced to `<string>` would say nothing. It is also the
 * one artifact where the whole declared flag set is recorded rather than only
 * the ones in use — Claude adding options classifies as additive and is merely
 * noted, while an option disappearing is worth a maintainer's attention whether
 * or not this adapter passes it today.
 *
 * `auth-status.json` keeps only its **shape**. The live payload carries an
 * email address, an organization id and an organization name, none of which
 * belongs in a commit; what the adapter depends on is that `loggedIn`,
 * `authMethod`, `apiProvider` and `subscriptionType` are still there and still
 * the types it narrows.
 *
 * Nothing here runs a turn. A `stream-json` transcript would need a billable
 * model call whose output differs every time, so it could never diff empty
 * twice; the record vocabulary is pinned by the reducer's own fixtures instead.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseVendorCliSurface } from '@mangostudio/shared/external-agents';
import { captureCommand } from '../../lib/exec';
import type { VendorContractSet } from '../lib/contract-set';
import { normalizeCapture, serializeCapture } from '../lib/normalize';

const ROOT_DIR = join(import.meta.dir, '..', '..', '..');
const CONTRACT_DIR = join(ROOT_DIR, 'apps/runtime/src/services/external-agents/claude/contract');

/** The option whose choice list the permission matrix maps onto. */
const PERMISSION_MODE_FLAG = '--permission-mode';

async function runClaude(args: readonly string[]): Promise<string | undefined> {
  const result = await captureCommand(['claude', ...args], { cwd: ROOT_DIR }).catch(
    () => undefined
  );
  if (result?.exitCode !== 0) return undefined;
  return result.stdout;
}

export const claudeContractSet: VendorContractSet = {
  id: 'claude-cli',
  vendor: 'claude',
  command: 'claude --help; claude auth status',
  artifactsDirectory: CONTRACT_DIR,
  manifestDirectory: CONTRACT_DIR,
  perFileDigests: true,

  async resolveVersion() {
    const banner = await runClaude(['--version']);
    const line = banner?.trim().split('\n')[0]?.trim();
    return line && line.length > 0 ? line : undefined;
  },

  async capture(destination) {
    const help = await runClaude(['--help']);
    if (help === undefined) throw new Error('`claude --help` produced no output.');
    const surface = parseVendorCliSurface(help, PERMISSION_MODE_FLAG);
    await writeFile(
      join(destination, 'cli-surface.json'),
      serializeCapture({
        flags: [...surface.flags].sort(),
        permissionModes: [...surface.choices].sort(),
      })
    );

    // A signed-out machine answers this with a different, smaller payload, and
    // recording that as the contract would delete fields the adapter reads. A
    // capture that cannot see a signed-in shape is refused rather than written.
    const status = await runClaude(['auth', 'status']);
    const parsed = status === undefined ? undefined : parseFirstJsonObject(status);
    if (parsed === undefined) {
      throw new Error(
        '`claude auth status` did not return a JSON object. Sign in before capturing this contract.'
      );
    }
    await writeFile(
      join(destination, 'auth-status.json'),
      serializeCapture(normalizeCapture(parsed))
    );
  },
};

/**
 * The first JSON object in the output, so an update notice printed above the
 * payload does not fail the capture — `parseClaudeAuthStatus` tolerates the
 * same thing for the same reason.
 */
function parseFirstJsonObject(output: string): Record<string, unknown> | undefined {
  const start = output.indexOf('{');
  if (start < 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(output.slice(start));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
