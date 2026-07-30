/**
 * Avatar colours for the tool identity registry.
 *
 * Every slot is a background/foreground pair per theme rather than a single hue
 * the avatar tints: a monogram has to stay legible on its own chip in both
 * themes, and only a stated pair can be asserted against a contrast threshold.
 * Values are literal so the contrast test reads the same numbers the browser
 * paints — a token indirection would leave the assertion checking nothing.
 *
 * Colour is derived from the *subject key*, never from the name, so renaming a
 * tool does not move it to a different colour.
 */

export interface ToolAvatarColors {
  readonly bg: string;
  readonly fg: string;
}

export interface ToolAvatarPalette {
  readonly slot: string;
  readonly dark: ToolAvatarColors;
  readonly light: ToolAvatarColors;
}

/** Brand-neutral families. Order is part of the contract: the hash indexes it. */
export const TOOL_AVATAR_PALETTE: readonly ToolAvatarPalette[] = [
  {
    slot: 'orange',
    dark: { bg: '#43210c', fg: '#fdba74' },
    light: { bg: '#ffedd5', fg: '#9a3412' },
  },
  { slot: 'teal', dark: { bg: '#0b332f', fg: '#5eead4' }, light: { bg: '#ccfbf1', fg: '#115e59' } },
  {
    slot: 'violet',
    dark: { bg: '#2e1065', fg: '#c4b5fd' },
    light: { bg: '#ede9fe', fg: '#5b21b6' },
  },
  {
    slot: 'amber',
    dark: { bg: '#3d1a03', fg: '#fcd34d' },
    light: { bg: '#fef3c7', fg: '#92400e' },
  },
  {
    slot: 'green',
    dark: { bg: '#052e16', fg: '#86efac' },
    light: { bg: '#dcfce7', fg: '#166534' },
  },
  { slot: 'blue', dark: { bg: '#172554', fg: '#93c5fd' }, light: { bg: '#dbeafe', fg: '#1e40af' } },
  { slot: 'rose', dark: { bg: '#4c0519', fg: '#fda4af' }, light: { bg: '#ffe4e6', fg: '#9f1239' } },
  {
    slot: 'fuchsia',
    dark: { bg: '#4a044e', fg: '#f0abfc' },
    light: { bg: '#fae8ff', fg: '#86198f' },
  },
  { slot: 'cyan', dark: { bg: '#083344', fg: '#67e8f9' }, light: { bg: '#cffafe', fg: '#155e75' } },
  {
    slot: 'slate',
    dark: { bg: '#1e293b', fg: '#cbd5e1' },
    light: { bg: '#e2e8f0', fg: '#334155' },
  },
];

/**
 * Slot per known tool id, keyed by the id half of the subject key.
 *
 * Keyed by id rather than by full subject key on purpose: `agent:claude` and
 * `runtime:claude` are the same tool seen from two tabs, and giving them one
 * colour is what makes the avatar recognisable across the umbrella.
 */
const SLOT_BY_TOOL_ID: Readonly<Record<string, string>> = {
  claude: 'orange',
  codex: 'teal',
  cursor: 'violet',
  bun: 'amber',
  node: 'green',
  mangostudio: 'blue',
  nvm: 'rose',
  fnm: 'fuchsia',
  volta: 'cyan',
};

/** FNV-1a: cheap, and stable across sessions and machines, which is all we need. */
function hashSubjectKey(subjectKey: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < subjectKey.length; index += 1) {
    hash ^= subjectKey.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * Palette for one subject. Known ids get their assigned family; everything else
 * — an MCP server, or an id added to a union before it gets a colour — takes a
 * deterministic slot, so it is stable rather than merely arbitrary.
 */
export function toolAvatarPalette(subjectKey: string): ToolAvatarPalette {
  const separatorIndex = subjectKey.indexOf(':');
  const toolId = separatorIndex === -1 ? subjectKey : subjectKey.slice(separatorIndex + 1);
  const namedSlot = SLOT_BY_TOOL_ID[toolId];
  const named = namedSlot
    ? TOOL_AVATAR_PALETTE.find((palette) => palette.slot === namedSlot)
    : undefined;
  if (named) return named;

  return TOOL_AVATAR_PALETTE[hashSubjectKey(subjectKey) % TOOL_AVATAR_PALETTE.length];
}
