/**
 * Turning the recorded `allow` set into something that actually refuses.
 *
 * Without this the consent file is a note about intent: `setup --profile
 * readonly` records that a hub may not run commands here, every handler stays
 * registered, and the next `shell.run` succeeds. A permission a system does not
 * enforce is worse than one it never offered, because somebody read the prompt
 * and believed the answer.
 *
 * Refusal happens at dispatch rather than at registration. A method that is not
 * registered comes back as `METHOD_UNSUPPORTED`, which is what an older runtime
 * says about a method it has never heard of — a hub cannot tell "this release
 * lacks it" from "this machine forbids it", and only one of those has a fix
 * anyone can act on. So the method stays in the map and answers with the
 * capability it needed and the command that grants it.
 *
 * The refusal travels as a service-error kind inside `details`, which is an
 * open record on the wire. `RuntimeErrorCodeSchema` is a closed union that an
 * older peer rejects outright, so a new top-level code would break exactly the
 * mixed-version pairing the compat window exists to protect.
 */

import type { RuntimeCapabilityAllow, RuntimeSlot } from '@mangostudio/shared/runtime-home';
import { RuntimeServiceError } from './errors';
import type { RuntimeMethodHandler } from './host';
import type { RuntimeMethod } from './methods';

/** Carried in `details.kind` so a hub can tell consent apart from a fault. */
export const CONSENT_DENIED_KIND = 'consent_denied';

/**
 * Which capabilities each protocol method needs, all of them.
 *
 * Keyed by `RuntimeMethod`, so adding a method without deciding what governs it
 * is a type error rather than a silently ungoverned hole — the alternative is a
 * default, and every safe default here is one somebody eventually regrets.
 *
 * Some methods need two. `library.apply` is a library operation *and* a write
 * to somebody's files, and `readonly` grants the first while refusing the
 * second; listing only `library` would have let the profile whose whole promise
 * is "no writes" write files.
 */
export const RUNTIME_METHOD_CAPABILITIES: Readonly<
  Record<RuntimeMethod, readonly (keyof RuntimeCapabilityAllow)[]>
> = {
  'fs.read-file': ['fsRead'],
  'fs.list-directory': ['fsRead'],
  'fs.glob': ['fsRead'],
  'fs.grep': ['fsRead'],
  'fs.write-file': ['fsWrite'],
  'fs.create-file': ['fsWrite'],
  'fs.edit-file': ['fsWrite'],
  'fs.replace-range': ['fsWrite'],
  'fs.delete-file': ['fsWrite'],
  'fs.move-file': ['fsWrite'],
  'fs.apply-patch': ['fsWrite'],
  'shell.run': ['shell'],
  'git.exec': ['git'],
  // Reading a file to remember it, and writing files back to undo a turn.
  'snapshot.capture': ['checkpoints', 'fsRead'],
  'snapshot.hash': ['checkpoints', 'fsRead'],
  'snapshot.revert': ['checkpoints', 'fsWrite'],
  'workspace.browse': ['fsRead'],
  'workspace.validate': ['fsRead'],
  'workspace.resolve-contained': ['fsRead'],
  'mcp.connect': ['mcp'],
  'mcp.list-tools': ['mcp'],
  'mcp.call-tool': ['mcp'],
  'mcp.list-resources': ['mcp'],
  'mcp.read-resource': ['mcp'],
  'mcp.list-prompts': ['mcp'],
  'mcp.get-prompt': ['mcp'],
  'mcp.elicit-response': ['mcp'],
  'mcp.disconnect': ['mcp'],
  'probing.runtimes': ['probing'],
  'probing.version-managers': ['probing'],
  'probing.agent-clis': ['probing'],
  // An install run executes an argv this machine's owner did not write. That is
  // the shell capability wearing a different name, and it answers to it.
  'install.run': ['shell'],
  'install.cancel': ['shell'],
  'library.scan': ['library'],
  'library.read': ['library'],
  'library.locations': ['library'],
  'library.settings-sources': ['library'],
  'library.apply': ['library', 'fsWrite'],
  'library.remove': ['library', 'fsWrite'],
  'library.undo': ['library', 'fsWrite'],
};

class RuntimeConsentDeniedError extends RuntimeServiceError {
  constructor(method: string, missing: readonly string[], slot: RuntimeSlot) {
    const because =
      missing.length > 0
        ? `this machine has not granted ${missing.join(' or ')}`
        : 'no capability governs it, so nothing can grant it';
    super(
      CONSENT_DENIED_KIND,
      `"${method}" is refused: ${because}. Run "mangostudio-runtime setup --slot ${slot}" there to change what a hub may do.`,
      { method, missing, slot }
    );
    this.name = 'RuntimeConsentDeniedError';
  }
}

/**
 * Wraps a handler map so denied methods refuse before they run.
 *
 * Returns the map untouched when nothing is denied, which is the ordinary case:
 * `host` and `wsl` slots resolve to full consent, so the profile that costs
 * nothing is the one almost every runtime has.
 */
export function gateHandlersByConsent(
  handlers: ReadonlyMap<string, RuntimeMethodHandler>,
  allow: RuntimeCapabilityAllow,
  slot: RuntimeSlot
): ReadonlyMap<string, RuntimeMethodHandler> {
  const gated = new Map<string, RuntimeMethodHandler>();
  let denied = false;

  for (const [method, handle] of handlers) {
    const missing = missingCapabilities(method, allow);
    if (missing?.length === 0) {
      gated.set(method, handle);
      continue;
    }
    denied = true;
    gated.set(method, () => {
      throw new RuntimeConsentDeniedError(method, missing ?? [], slot);
    });
  }

  return denied ? gated : handlers;
}

/**
 * Which of a method's capabilities this machine has not granted, or null when
 * nothing governs the method at all.
 *
 * Null is a refusal, not a pass. The table is exhaustive over `RuntimeMethod`,
 * so reaching it means a handler was registered under a name the protocol does
 * not declare — and deciding that an unrecognised name must be harmless is how
 * a gate becomes decorative.
 */
function missingCapabilities(
  method: string,
  allow: RuntimeCapabilityAllow
): readonly (keyof RuntimeCapabilityAllow)[] | null {
  const required = RUNTIME_METHOD_CAPABILITIES[method as RuntimeMethod];
  return required ? required.filter((capability) => !allow[capability]) : null;
}
