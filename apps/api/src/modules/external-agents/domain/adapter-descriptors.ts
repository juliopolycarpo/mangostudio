/**
 * Product-level declarations about the external agents MangoStudio can host.
 *
 * Everything here is a MangoStudio decision: what a target is called, the order
 * it appears in, the command a signed-out user runs, and the copy explaining
 * what each permission level means. None of it is a claim about what a vendor
 * can do.
 *
 * Capabilities and supported permission combinations are deliberately absent.
 * A hub-side capability table cannot be the truth: it is the adapter that will
 * run the turn, on a runtime that may be older or newer than this hub, and a
 * second table here would disagree with it after any version skew. The adapter
 * answers, and `external-agent-discovery.ts` renders that answer.
 */

import type {
  ExternalAgentTargetId,
  ExternalPermissionLevel,
} from '@mangostudio/shared/external-agents';

export interface ExternalAgentProductDescriptor {
  readonly targetId: ExternalAgentTargetId;
  /** Position in the runner selector: Codex, then Cursor, then Claude Code. */
  readonly order: number;
  /** Reuses the library's target labels; a second name for the same tool would drift. */
  readonly displayNameKey: `library.targets.${ExternalAgentTargetId}`;
  /**
   * The literal command that signs a user in, shown with a copy button.
   *
   * Verified against the installed CLIs on 2026-08-08: `codex --help` lists
   * `login`, `cursor-agent --help` lists `login`, and `claude auth --help`
   * lists `login`.
   */
  readonly loginCommand: string;
}

/**
 * i18n keys for what each permission level means, as product copy.
 *
 * One set for all vendors, because the level is product vocabulary rather than
 * a vendor setting — Codex reaches `read-only` through a sandbox flag, Cursor
 * through a session mode and Claude through `plan`, and the user is choosing
 * the same thing in all three.
 */
export const EXTERNAL_PERMISSION_LEVEL_COPY_KEYS: Readonly<
  Record<ExternalPermissionLevel, string>
> = {
  'read-only': 'externalAgents.permission.level.read-only',
  default: 'externalAgents.permission.level.default',
  'full-access': 'externalAgents.permission.level.full-access',
};

const DESCRIPTORS: readonly ExternalAgentProductDescriptor[] = [
  {
    targetId: 'codex',
    order: 0,
    displayNameKey: 'library.targets.codex',
    loginCommand: 'codex login',
  },
  {
    targetId: 'cursor',
    order: 1,
    displayNameKey: 'library.targets.cursor',
    loginCommand: 'cursor-agent login',
  },
  {
    targetId: 'claude',
    order: 2,
    displayNameKey: 'library.targets.claude',
    loginCommand: 'claude auth login',
  },
];

/** Every hosted target, in selector order. */
export const EXTERNAL_AGENT_PRODUCT_DESCRIPTORS: readonly ExternalAgentProductDescriptor[] = [
  ...DESCRIPTORS,
].sort((left, right) => left.order - right.order);

export function productDescriptorFor(
  targetId: ExternalAgentTargetId
): ExternalAgentProductDescriptor | undefined {
  return DESCRIPTORS.find((descriptor) => descriptor.targetId === targetId);
}
