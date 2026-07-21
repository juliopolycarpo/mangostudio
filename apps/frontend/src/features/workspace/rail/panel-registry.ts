import type { AgentExecutionMode } from '@mangostudio/shared/agents';
import type { TodoList } from '@mangostudio/shared/todos';
import type { WorkspacePanelId, WorkspacePanelSettings } from '@mangostudio/shared/workspaces';
import { FolderGit2, ListTodo, type LucideIcon } from 'lucide-react';
import type { ComponentType } from 'react';
import { GitPanel } from '../GitPanel';
import { TodoRailPanel } from './TodoRailPanel';

export type RailPanelTitleKey = 'git' | 'todos';

export interface RailPanelAvailabilityState {
  readonly agentExecutionMode: AgentExecutionMode;
  readonly chatId: string | null;
  readonly workdir: string | null;
  readonly todoCount: number;
}

interface RailPanelContentProps {
  readonly chatId: string;
  readonly todos: TodoList;
}

export interface RailPanelDefinition {
  readonly id: WorkspacePanelId;
  readonly titleKey: RailPanelTitleKey;
  readonly icon: LucideIcon;
  readonly availability: (state: RailPanelAvailabilityState) => boolean;
  readonly component: ComponentType<RailPanelContentProps>;
}

export const WORKSPACE_PANEL_REGISTRY: readonly RailPanelDefinition[] = [
  {
    id: 'git',
    titleKey: 'git',
    icon: FolderGit2,
    availability: ({ agentExecutionMode, chatId, workdir }) =>
      agentExecutionMode === 'agent' && Boolean(chatId && workdir),
    component: GitPanel,
  },
  {
    id: 'todos',
    titleKey: 'todos',
    icon: ListTodo,
    availability: ({ agentExecutionMode, chatId, todoCount }) =>
      agentExecutionMode === 'agent' && Boolean(chatId) && todoCount > 0,
    component: TodoRailPanel,
  },
];

export function getAvailableWorkspacePanels(
  state: RailPanelAvailabilityState,
  settings: WorkspacePanelSettings
): RailPanelDefinition[] {
  const visibleIds = new Set(settings.visiblePanelIds);
  const registryById = new Map(WORKSPACE_PANEL_REGISTRY.map((panel) => [panel.id, panel]));

  return settings.panelOrder.flatMap((panelId) => {
    const panel = registryById.get(panelId);
    return panel && visibleIds.has(panelId) && panel.availability(state) ? [panel] : [];
  });
}
