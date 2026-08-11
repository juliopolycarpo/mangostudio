/**
 * The Cursor ACP contract, captured from a live `cursor-agent acp` handshake.
 *
 * There is no generator to run, so the contract is what the binary answered.
 * Three exchanges are recorded, and each is here because an adapter reads it:
 *
 * | Artifact             | What the adapter reads off it                        |
 * | -------------------- | ---------------------------------------------------- |
 * | `initialize.json`    | `protocolVersion` and every derived capability flag  |
 * | `session-new.json`   | the mode ids the permission matrix maps onto         |
 * | `session-list.json`  | the page shape `listSessions` pages through          |
 *
 * All three are normalized before they are written. `session/list` returns the
 * operator's own session titles and working directories, and `session/new`
 * returns a fresh uuid and the account's whole model catalog — none of which is
 * reproducible and none of which belongs in a commit. What survives is the
 * shape, plus the mode ids, which are the one value the adapter branches on.
 *
 * Model ids are deliberately *not* preserved. Cursor's catalog turns over
 * constantly, the adapter passes whatever it is given through verbatim, and a
 * capture that listed every model would report drift every week for a contract
 * that never moved.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureCommand } from '../../lib/exec';
import type { VendorContractSet } from '../lib/contract-set';
import { normalizeCapture, serializeCapture } from '../lib/normalize';
import { openStdioRpc } from '../lib/stdio-rpc';

const ROOT_DIR = join(import.meta.dir, '..', '..', '..');
const CONTRACT_DIR = join(ROOT_DIR, 'apps/runtime/src/services/external-agents/cursor/contract');

/**
 * Keys whose value is the contract rather than an instance of it.
 *
 * `protocolVersion` is the negotiated number the adapter refuses to downgrade
 * from. `id` and `currentModeId` are the permission matrix's whole vocabulary —
 * `agent`, `plan`, `ask` — so a mode disappearing has to be visible as a
 * removal rather than as one `<string>` among three staying `<string>`.
 *
 * `id` is safe to preserve here because the only `id` fields these three
 * replies carry are auth-method and mode identifiers. `sessionId` is a
 * different key and is not on this list.
 */
const PRESERVE_AT = ['protocolVersion', 'id', 'currentModeId'];

/** The `cursor-agent` version banner, or `undefined` when it is not installed. */
async function resolveCursorVersion(): Promise<string | undefined> {
  const result = await captureCommand(['cursor-agent', '--version'], { cwd: ROOT_DIR }).catch(
    () => undefined
  );
  if (result?.exitCode !== 0) return undefined;
  const banner = result.stdout.trim().split('\n')[0]?.trim();
  return banner && banner.length > 0 ? banner : undefined;
}

export const cursorContractSet: VendorContractSet = {
  id: 'cursor-acp',
  vendor: 'cursor',
  command: 'cursor-agent acp — initialize, session/new, session/list',
  artifactsDirectory: CONTRACT_DIR,
  manifestDirectory: CONTRACT_DIR,
  perFileDigests: true,
  resolveVersion: resolveCursorVersion,

  async capture(destination) {
    // A throwaway working directory, so `session/new` never records anything
    // about this repository and `session/list` has a cwd that is not a user's.
    const workspace = await mkdtemp(join(tmpdir(), 'cursor-contract-'));
    const session = openStdioRpc({ argv: ['cursor-agent', 'acp'], cwd: workspace });
    try {
      const initialize = await session.request('initialize', {
        protocolVersion: 1,
        // The same declined client capabilities the adapter sends. Capturing a
        // handshake taken under different terms would record a reply the
        // runtime never actually receives.
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      });
      const created = await session.request('session/new', { cwd: workspace, mcpServers: [] });
      const listed = await session.request('session/list', {});

      const artifacts: ReadonlyArray<readonly [string, unknown]> = [
        ['initialize.json', initialize],
        ['session-new.json', created],
        ['session-list.json', pageForCreatedSession(listed, created)],
      ];
      for (const [name, value] of artifacts) {
        await writeFile(
          join(destination, name),
          serializeCapture(normalizeCapture(value, { preserveAt: PRESERVE_AT }))
        );
      }
    } finally {
      session.close();
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    }
  },
};

/**
 * The listing page, narrowed to the session this capture just created.
 *
 * `session/list` answers with the operator's entire session history, and that
 * history is the one thing in these three replies that is *not* the vendor's
 * contract. Its shape varies with what the machine happens to have done: a
 * session with a title contributes a key that a machine with no titled sessions
 * would never produce, so a whole-page capture would drift between a
 * maintainer's laptop and a CI runner for reasons that have nothing to do with
 * Cursor. Recording nothing would be worse — the page envelope is what
 * `listSessions` pages through.
 *
 * The session created moments ago is the fix: it is a genuine element the
 * vendor produced, and it is identical on every machine because it is new.
 * Everything outside `sessions` is kept as it arrived, so a `nextCursor` or a
 * renamed envelope key is still visible.
 */
function pageForCreatedSession(listed: unknown, created: unknown): unknown {
  const page = listed as { readonly sessions?: unknown } | null;
  const sessionId = (created as { readonly sessionId?: unknown } | null)?.sessionId;
  if (!page || typeof page !== 'object' || !Array.isArray(page.sessions)) return listed;
  const mine = page.sessions.filter(
    (entry) => (entry as { readonly sessionId?: unknown } | null)?.sessionId === sessionId
  );
  return { ...page, sessions: mine };
}
