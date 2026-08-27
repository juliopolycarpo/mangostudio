import type { TodoList } from '@mangostudio/shared/todos';
import type { WorkspacePanelId, WorkspacePanelSettings } from '@mangostudio/shared/workspaces';
import { FolderGit2, GitPullRequest, ListTodo, type LucideIcon } from 'lucide-react';
import type { ComponentType } from 'react';
import { GithubPanel } from '@/features/github/components/GithubPanel';
import { GitPanel } from '../GitPanel';
import { TodoRailPanel } from './TodoRailPanel';

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
}

export interface RailPanelDefinition {
  readonly id: WorkspacePanelId;
  readonly icon: LucideIcon;
  readonly availability: (state: RailPanelAvailabilityState) => boolean;
  readonly component: ComponentType<RailPanelContentProps>;
}

export const WORKSPACE_PANEL_REGISTRY: readonly RailPanelDefinition[] = [
  {
    id: 'git',
    icon: FolderGit2,
    availability: ({ chatId, workdir }) => Boolean(chatId && workdir),
    component: GitPanel,
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
    component: GithubPanel,
  },
  {
    id: 'todos',
    icon: ListTodo,
    availability: ({ chatId, todoCount }) => Boolean(chatId) && todoCount > 0,
    component: TodoRailPanel,
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
