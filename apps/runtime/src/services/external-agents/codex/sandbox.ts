/**
 * The two differently-shaped sandbox fields, encoded through two helpers that
 * cannot be swapped.
 *
 * `thread/start` takes `sandbox`, a kebab-case **string**. `turn/start` takes
 * `sandboxPolicy`, an internally tagged camelCase **object**. Sending the
 * string form to `turn/start` is not a soft failure — the server answers
 * `invalid type: string "read-only", expected internally tagged enum
 * SandboxPolicyDeserialize` and the turn never begins.
 *
 * Nothing here guesses. The generated `SandboxPolicy` marks every member of
 * `readOnly` and `workspaceWrite` as required, so `networkAccess`,
 * `writableRoots`, `excludeSlashTmp` and `excludeTmpdirEnvVar` must each be
 * written down. That is the intended outcome rather than an inconvenience:
 * network access is an axis of its own, orthogonal to the permission level, and
 * a default inherited from Codex's config layers is a policy MangoStudio did
 * not choose. The wire contract does default them — the JSON Schema gives every
 * one of those fields a `default` — which is exactly why the typed form, being
 * stricter than the wire, is the one to encode through.
 *
 * **What these encoders do and do not guarantee.** They guarantee the request
 * is transmitted and that it beats Codex's own config layers: probed against
 * 0.147.0 on a machine whose `~/.codex/config.toml` set
 * `default_permissions = ":danger-full-access"`, an explicit `read-only`
 * request came back echoed as `{"type":"readOnly","networkAccess":false}`.
 * They guarantee nothing about **enforcement**, which belongs to Codex and to
 * the host kernel. On that same machine — a WSL2 kernel with no Landlock LSM —
 * a shell write inside that read-only sandbox succeeded with exit 0 and no
 * approval request. MangoStudio cannot detect that from the protocol: the echo
 * reports the level Codex believes is in force. Treat the permission level as
 * a request faithfully relayed, never as a sandbox MangoStudio is imposing.
 */

import type { ExternalPermissionLevel } from '@mangostudio/shared/external-agents';
import type { AbsolutePathBuf } from './protocol/AbsolutePathBuf';
import type { SandboxMode } from './protocol/v2/SandboxMode';
import type { SandboxPolicy } from './protocol/v2/SandboxPolicy';

/**
 * Network access for the two levels that have the field.
 *
 * Restricted, deliberately. An external agent that can reach the network from
 * inside a read-only sandbox can still exfiltrate the workspace it just read,
 * so the level's promise would be about writes only. `full-access` does not
 * appear here because `dangerFullAccess` carries no `networkAccess` field: at
 * that level the vendor grants everything, which is what the name says.
 */
const NETWORK_ACCESS = false;

/**
 * `thread/start .sandbox` — the string form.
 *
 * Returns `SandboxMode`, a string union. It is structurally impossible to pass
 * this where `encodeTurnSandboxPolicy`'s result belongs: `SandboxPolicy` is a
 * tagged object in every member, so a string fails to type-check against all of
 * them. `tests/unit/services/codex-sandbox.test.ts` pins that with an
 * `@ts-expect-error`, which fails the build if the shapes ever converge.
 */
export function encodeThreadSandboxMode(level: ExternalPermissionLevel): SandboxMode {
  switch (level) {
    case 'read-only':
      return 'read-only';
    case 'default':
      return 'workspace-write';
    case 'full-access':
      return 'danger-full-access';
  }
}

/**
 * `turn/start .sandboxPolicy` — the object form.
 *
 * `writableRoots` is where MangoStudio's workdir belongs, and it is the reason
 * this takes the roots rather than reading them from anywhere: the supervisor
 * authorized a specific set of directories when the session opened, and a turn
 * may narrow that set but never widen it.
 */
export function encodeTurnSandboxPolicy(
  level: ExternalPermissionLevel,
  writableRoots: readonly AbsolutePathBuf[]
): SandboxPolicy {
  switch (level) {
    case 'read-only':
      return { type: 'readOnly', networkAccess: NETWORK_ACCESS };
    case 'default':
      return {
        type: 'workspaceWrite',
        writableRoots: [...writableRoots],
        networkAccess: NETWORK_ACCESS,
        // Codex's own defaults for both, restated because the generated type
        // requires them. Excluding the temp directories would narrow the
        // sandbox below what `workspace-write` means everywhere else Codex runs.
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
    case 'full-access':
      return { type: 'dangerFullAccess' };
  }
}
