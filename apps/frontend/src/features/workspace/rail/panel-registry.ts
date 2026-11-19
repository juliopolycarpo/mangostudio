import type { TodoList } from '@mangostudio/shared/todos';
import type { WorkspacePanelId, WorkspacePanelSettings } from '@mangostudio/shared/workspaces';
import {
  FolderGit2,
  GitPullRequest,
  ListTodo,
  type LucideIcon,
  TerminalSquare,
} from 'lucide-react';
import type { ComponentType } from 'react';

import { type RetryableLazy, retryableLazy } from '@/lib/retryable-lazy';

// The bodies of the panels that pull the most code (the repository view, the
// GitHub review queue, the todo list, the terminal's session tabs and queries)
// load the first time their panel is shown.
// This registry is reachable from the command palette and the chat page, so a
// static import here would put all of it in the entry chunk of every
// authenticated route, whether or not the rail ever opens. The dock only needs
// each panel's id, icon and availability to draw its buttons.
const GitPanel = retryableLazy<RailPanelContentProps>(() =>
  import('../GitPanel').then((module) => ({ default: module.GitPanel }))
);
const GithubPanel = retryableLazy<RailPanelContentProps>(() =>
  import('@/features/github/components/GithubPanel').then((module) => ({
    default: module.GithubPanel,
  }))
);
const TodoRailPanel = retryableLazy<RailPanelContentProps>(() =>
  import('./TodoRailPanel').then((module) => ({ default: module.TodoRailPanel }))
);
const TerminalPanel = retryableLazy<RailPanelContentProps>(() =>
  import('@/features/terminal/TerminalRailPanel').then((module) => ({
    default: module.TerminalRailPanel,
  }))
);

export interface RailPanelAvailabilityState {
  readonly chatId: string | null;
  readonly workdir: string | null;
  readonly todoCount: number;
}

interface RailPanelContentProps {
  readonly chatId: string;
  /**
   * The chat's folder, for panels that show one half of themselves without it.
   * The GitHub panel needs it as *data* rather than as an availability gate —
   * its review queue is not repo-scoped, so it renders with or without a
   * checkout and says so in the half that is.
   */
  readonly workdir: string | null;
  readonly todos: TodoList;
  /** The machine the chat runs on. Null before the chat's environment is known. */
  readonly environmentId: string | null;
}

export interface RailPanelDefinition {
  readonly id: WorkspacePanelId;
  readonly icon: LucideIcon;
  readonly availability: (state: RailPanelAvailabilityState) => boolean;
  readonly component: ComponentType<RailPanelContentProps>;
  /**
   * Present when `component` is fetched on first use: `preload` warms the chunk
   * from a hover or focus on the dock button, `reset` lets a failed fetch be
   * asked for again. Panels bundled with the entry have neither.
   */
  readonly lazyBody?: Pick<RetryableLazy<RailPanelContentProps>, 'preload' | 'reset'>;
}

export const WORKSPACE_PANEL_REGISTRY: readonly RailPanelDefinition[] = [
  {
    id: 'git',
    icon: FolderGit2,
    availability: ({ chatId, workdir }) => Boolean(chatId && workdir),
    component: GitPanel.Component,
    lazyBody: GitPanel,
  },
  {
    // Available on `chatId` alone, unlike `git`. The panel's upper half is the
    // cross-repository review queue, which is about the person and not about a
    // checkout — requiring a workdir would hide a full inbox from anybody whose
    // chat has no folder bound yet. The repository half gates itself.
    id: 'github',
    // lucide-react removed its brand icons, so there is no `Github` to import;
    // `GitPullRequest` is what the rest of this codebase already uses for it.
    icon: GitPullRequest,
    availability: ({ chatId }) => Boolean(chatId),
    component: GithubPanel.Component,
    lazyBody: GithubPanel,
  },
  {
    id: 'todos',
    icon: ListTodo,
    availability: ({ chatId, todoCount }) => Boolean(chatId) && todoCount > 0,
    component: TodoRailPanel.Component,
    lazyBody: TodoRailPanel,
  },
  {
    id: 'terminal',
    icon: TerminalSquare,
    availability: ({ chatId }) => Boolean(chatId),
    component: TerminalPanel.Component,
    lazyBody: TerminalPanel,
  },
];

const REGISTRY_BY_ID = new Map(WORKSPACE_PANEL_REGISTRY.map((panel) => [panel.id, panel]));

export function getAvailableWorkspacePanels(
  state: RailPanelAvailabilityState,
  settings: WorkspacePanelSettings
): RailPanelDefinition[] {
  return settings.panelOrder.flatMap((panelId) => {
    const panel = REGISTRY_BY_ID.get(panelId);
    return panel && isWorkspacePanelVisible(panelId, settings) && panel.availability(state)
      ? [panel]
      : [];
  });
}

/**
 * Whether the user has kept this panel in the rail at all.
 *
 * Separate from `availability`, which answers about the current chat. Callers
 * outside the rail that offer a shortcut *into* a panel need this half: the
 * rail drops a hidden panel, so a command-palette row that ignores it opens
 * whichever panel is first instead of the one the row names.
 *
 * @example
 * isWorkspacePanelVisible('github', workspaceSettings.sidePanel);
 */
export function isWorkspacePanelVisible(
  panelId: WorkspacePanelId,
  settings: WorkspacePanelSettings
): boolean {
  return settings.visiblePanelIds.includes(panelId);
}
