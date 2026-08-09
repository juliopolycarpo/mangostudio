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
 * The allow set is re-read on every call through {@link RuntimeConsentSource},
 * so a mid-connection `setup` takes effect without reconnecting. The typed wire
 * code is `RUNTIME_DENIED` (see `errorPayloadFor`); older peers that have not
 * learned that literal still receive a decodeable frame because the protocol
 * keeps `err.code` open and narrows unknowns to `INTERNAL`.
 */

import type { RuntimeCapabilityAllow, RuntimeSlot } from '@mangostudio/shared/runtime-home';
import type { RuntimeConsentSource } from './consent-source';
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
  'external-agent.discover': ['externalAgents'],
  'external-agent.open': ['externalAgents'],
  'external-agent.turn': ['externalAgents'],
  'external-agent.respond': ['externalAgents'],
  'external-agent.cancel': ['externalAgents'],
  'external-agent.close': ['externalAgents'],
  'probing.runtimes': ['probing'],
  'probing.version-managers': ['probing'],
  'probing.agent-clis': ['probing'],
  // An install run executes an argv this machine's owner did not write. That is
  // the shell capability wearing a different name, and it answers to it.
  'install.run': ['shell'],
  'install.cancel': ['shell'],
  'library.scan': ['library'],
  'library.read': ['library'],
  'library.read-tree': ['library'],
  'library.locations': ['library'],
  'library.settings-sources': ['library'],
  'library.apply': ['library', 'fsWrite'],
  'library.remove': ['library', 'fsWrite'],
  'library.undo': ['library', 'fsWrite'],
  // Listing is a read even though the sets it lists were written: a machine
  // downgraded to readonly still has a history, and hiding it would tell the
  // user their backups are gone rather than that this hub may no longer write.
  'library.backups': ['library'],
  'library.gc': ['library', 'fsWrite'],
  // Intentionally empty: health must answer under every profile.
  'runtime.health': [],
  'runtime.update.begin': ['update'],
  'runtime.update.chunk': ['update'],
  'runtime.update.commit': ['update'],
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
      { method, missing, slot, capability: missing[0] }
    );
    this.name = 'RuntimeConsentDeniedError';
  }
}

/**
 * Wraps a handler map so denied methods refuse before they run.
 *
 * Every method is wrapped: the source re-reads consent on each call, so a map
 * that looked fully granted at connect can refuse mid-connection after `setup`.
 */
export function gateHandlersByConsent(
  handlers: ReadonlyMap<string, RuntimeMethodHandler>,
  consent: RuntimeConsentSource
): ReadonlyMap<string, RuntimeMethodHandler> {
  const gated = new Map<string, RuntimeMethodHandler>();

  for (const [method, handle] of handlers) {
    gated.set(method, async (params, context) => {
      const allow = await consent.refresh();
      const missing = missingCapabilities(method, allow);
      if (missing?.length === 0) {
        return await handle(params, context);
      }
      throw new RuntimeConsentDeniedError(method, missing ?? [], consent.slot);
    });
  }

  return gated;
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
