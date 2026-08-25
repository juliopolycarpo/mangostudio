/**
 * The colour a runner is known by, in the two forms the app asks for it.
 *
 * Three surfaces draw the same identity — the sidebar's session dot, the
 * composer's frame and the hub's agent pill — and each had grown its own copy
 * of the target-to-token table. A fourth vendor meant editing three files, and
 * until all three landed the surfaces disagreed about who was who.
 *
 * Both forms are written out per entry rather than built from a stem: Tailwind
 * scans source text for class names, so a `bg-agent-${stem}` template produces
 * a utility that is never generated and a dot that renders transparent.
 */

export interface AgentIdentityTokens {
  /** Tailwind background utility for the identity dot. */
  readonly dotClass: string;
  /**
   * `var()` reference rather than a literal colour, so the value keeps tracking
   * the theme — every one of these tokens has a light-mode override, and a
   * resolved hex would freeze the dark one in place.
   */
  readonly colorVar: string;
}

/** MangoStudio's own hue, for a chat no vendor owns. */
export const MANGO_IDENTITY: AgentIdentityTokens = {
  dotClass: 'bg-agent-mango',
  colorVar: 'var(--color-agent-mango)',
};

/**
 * The neutral harness colour. A target this bundle predates still gets drawn —
 * whoever is running the turn, it is not us.
 */
const GENERIC_IDENTITY: AgentIdentityTokens = {
  dotClass: 'bg-agent-generic',
  colorVar: 'var(--color-agent-generic)',
};

const AGENT_IDENTITY: Readonly<Record<string, AgentIdentityTokens>> = {
  codex: { dotClass: 'bg-agent-codex', colorVar: 'var(--color-agent-codex)' },
  claude: { dotClass: 'bg-agent-claude', colorVar: 'var(--color-agent-claude)' },
  cursor: { dotClass: 'bg-agent-cursor', colorVar: 'var(--color-agent-cursor)' },
};

/**
 * Identity tokens for an external agent, falling back to the generic harness
 * colour for a target this bundle does not know.
 *
 * // Usage: agentIdentityTokens('codex').dotClass // => 'bg-agent-codex'
 */
export function agentIdentityTokens(targetId: string): AgentIdentityTokens {
  return AGENT_IDENTITY[targetId] ?? GENERIC_IDENTITY;
}
