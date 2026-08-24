/**
 * What a palette row is, and what a provider has to return.
 *
 * Every source is a pure function over data the app already has in cache, so a
 * provider can be exercised in a unit test with no DOM, no router and no query
 * client — the palette's behaviour is then only about ranking and keyboard
 * handling.
 */

import type { LucideIcon } from 'lucide-react';

/**
 * Rows are grouped under a section heading, and the sections render in a fixed
 * order regardless of score. A palette whose headings reorder as you type is
 * one you cannot build muscle memory for.
 */
export type CommandSection = 'sessions' | 'actions' | 'navigate' | 'environments';

export const COMMAND_SECTIONS: readonly CommandSection[] = [
  'sessions',
  'actions',
  'navigate',
  'environments',
];

interface CommandBadge {
  /** Short mono label — the harness a session belongs to. */
  readonly label: string;
  /** Tailwind background utility for the identity dot beside it. */
  readonly dotClassName: string;
}

export interface CommandItem {
  /** Stable across renders: it is the `aria-activedescendant` target. */
  readonly id: string;
  readonly section: CommandSection;
  readonly label: string;
  /**
   * Dim secondary text beside the label — a folder, a route, a hostname.
   * Searchable: whatever a row shows, a user can type.
   */
  readonly hint?: string;
  /** Right-aligned dim text — a relative time, a connection state. */
  readonly meta?: string;
  /**
   * Extra searchable text the row does not render. Both this and the hint rank
   * below every label match, so typing a folder name surfaces its sessions
   * without letting them outrank a session actually called that.
   */
  readonly keywords?: string;
  readonly icon?: LucideIcon;
  readonly badge?: CommandBadge;
  /** Shortcut chip for an action that also has a global chord. */
  readonly shortcut?: string;
  readonly run: () => void | Promise<void>;
}
