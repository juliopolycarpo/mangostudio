import {
  CURSOR_MIN_NODE_VERSION,
  type ProviderRuntimeUnavailableReason,
} from '@mangostudio/shared/provider-settings';
import { getConfig } from '../../../lib/config';
import {
  type NodeRuntimeStatus as CoreNodeRuntimeStatus,
  createNodeRuntimeDetector,
  type NodeRuntimeProbeDeps,
  nodeBinaryCandidateNames,
  wellKnownNodeDirectories,
} from '../core/node-sidecar/node-runtime';

export type NodeRuntimeStatus = CoreNodeRuntimeStatus<ProviderRuntimeUnavailableReason>;
export type { NodeRuntimeProbeDeps };
export { nodeBinaryCandidateNames, wellKnownNodeDirectories };

const cursorNodeRuntimeDetector = createNodeRuntimeDetector<ProviderRuntimeUnavailableReason>({
  minimumVersion: parseMinimumNodeVersion(CURSOR_MIN_NODE_VERSION),
  reasonCodes: {
    nodeNotFound: 'cursor.node_not_found',
    nodeInvalid: 'cursor.node_invalid',
    versionInsufficient: 'cursor.version_insufficient',
  },
  getConfiguredNodePath: () => getConfig().cursor.nodePath.trim(),
});

function parseMinimumNodeVersion(value: string): { major: number; minor: number } {
  const [major, minor] = value.split('.').map((part) => Number(part));
  return {
    major: Number.isFinite(major) ? major : 22,
    minor: Number.isFinite(minor) ? minor : 13,
  };
}

/**
 * Resolves Node availability for the Cursor SDK sidecar with injectable deps
 * (exported for unit tests). A configured path is authoritative, so a typo'd
 * MANGO_NODE_PATH surfaces as `cursor.node_invalid` instead of silently
 * running a different Node than the user asked for.
 */
export function probeNodeRuntime(
  overrides: Partial<NodeRuntimeProbeDeps> = {}
): Promise<NodeRuntimeStatus> {
  return cursorNodeRuntimeDetector.probeNodeRuntime(overrides);
}

/**
 * Returns cached Node.js availability for the Cursor SDK sidecar.
 *
 * The probe runs `node --version` in a child process; doing so asynchronously
 * keeps it off the event loop so callers on request paths (for example, the
 * provider settings descriptor endpoint) never block. Concurrent probes are
 * deduped.
 *
 * The 30s TTL means a user who installs Node (or fixes MANGO_NODE_PATH) while
 * MangoStudio is running is picked up on the next probe without a restart;
 * call resetNodeRuntimeCache() to force an immediate re-probe.
 */
export function detectNodeRuntime(options?: { force?: boolean }): Promise<NodeRuntimeStatus> {
  return cursorNodeRuntimeDetector.detectNodeRuntime(options);
}

/** Clears the cached Node runtime probe (tests, config reloads). */
export function resetNodeRuntimeCache(): void {
  cursorNodeRuntimeDetector.resetNodeRuntimeCache();
}
