import {
  WORKSPACE_PANEL_WIDTH_MAX,
  WORKSPACE_PANEL_WIDTH_MIN,
  type WorkspacePanelId,
  type WorkspacePanelSettings,
} from '@mangostudio/shared/workspaces';
import { PanelRightOpen } from 'lucide-react';
import { type Ref, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EdgeResizeHandle } from '@/components/layout/EdgeResizeHandle';
import { Button } from '@/components/ui/Button';
import { useChatTodos } from '@/features/chat/hooks/use-chat-todos';
import { useI18n } from '@/hooks/use-i18n';
import { getAvailableWorkspacePanels, type RailPanelDefinition } from './panel-registry';
import { RailPanel } from './RailPanel';
import { readRailCollapsed, writeRailCollapsed } from './rail-state';

const DESKTOP_RAIL_QUERY = '(min-width: 1024px)';
const COLLAPSED_RAIL_WIDTH = 48;

interface WorkspaceRailProps {
  readonly chatId: string;
  readonly workdir: string | null;
  readonly settings: WorkspacePanelSettings;
  readonly onWidthChange?: (width: number) => void;
}

export function WorkspaceRail({ chatId, workdir, settings, onWidthChange }: WorkspaceRailProps) {
  const { t } = useI18n();
  const todosQuery = useChatTodos(chatId);
  const todos = todosQuery.data?.todos ?? [];
  const panelTitles: Readonly<Record<WorkspacePanelId, string>> = {
    git: t.git.title,
    github: t.github.title,
    todos: t.chat.todo.title,
  };
  const availablePanels = useMemo(
    () => getAvailableWorkspacePanels({ chatId, workdir, todoCount: todos.length }, settings),
    [chatId, settings, todos.length, workdir]
  );
  const [activePanelId, setActivePanelId] = useState<WorkspacePanelId | null>(
    () => availablePanels[0]?.id ?? null
  );
  const [collapsed, setCollapsedState] = useState(() => readRailCollapsed(chatId));
  const [mobileOpen, setMobileOpen] = useState(false);
  const [width, setWidth] = useState(settings.width);
  const widthRef = useRef(width);
  const mobileTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileCloseRef = useRef<HTMLButtonElement>(null);
  const isDesktop = useDesktopRail();

  useEffect(() => {
    setWidth(settings.width);
    widthRef.current = settings.width;
  }, [settings.width]);

  useEffect(() => {
    if (!availablePanels.some((panel) => panel.id === activePanelId)) {
      setActivePanelId(availablePanels[0]?.id ?? null);
    }
  }, [activePanelId, availablePanels]);

  const closeMobile = useCallback(() => {
    setMobileOpen(false);
    mobileTriggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!mobileOpen) return;
    mobileCloseRef.current?.focus();
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') closeMobile();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [closeMobile, mobileOpen]);

  useEffect(() => {
    if (isDesktop) setMobileOpen(false);
  }, [isDesktop]);

  const setCollapsed = (nextCollapsed: boolean) => {
    setCollapsedState(nextCollapsed);
    writeRailCollapsed(chatId, nextCollapsed);
  };

  const selectPanel = (panelId: WorkspacePanelId) => {
    setActivePanelId(panelId);
    if (collapsed) setCollapsed(false);
  };

  // EdgeResizeHandle already clamps and rounds against the same bounds.
  const resize = (nextWidth: number) => {
    widthRef.current = nextWidth;
    setWidth(nextWidth);
  };

  const commitWidth = () => {
    onWidthChange?.(widthRef.current);
  };

  if (availablePanels.length === 0) return null;

  const activePanel =
    availablePanels.find((panel) => panel.id === activePanelId) ?? availablePanels[0];
  const activeTitle = panelTitles[activePanel.id];
  const ActivePanelContent = activePanel.component;
  const panelContent = (
    closeMode: 'collapse' | 'close',
    onClose: () => void,
    closeButtonRef?: Ref<HTMLButtonElement>
  ) => (
    <RailPanel
      icon={activePanel.icon}
      title={activeTitle}
      closeMode={closeMode}
      closeButtonRef={closeButtonRef}
      closeLabel={
        closeMode === 'collapse' ? t.workspace.sidePanelCollapse : t.workspace.sidePanelClose
      }
      onClose={onClose}
    >
      <ActivePanelContent chatId={chatId} todos={todos} />
    </RailPanel>
  );

  if (isDesktop) {
    return (
      <aside
        aria-label={t.workspace.sidePanelTitle}
        className="relative flex h-full shrink-0 border-l border-outline-variant/15 bg-surface-container-low"
        style={{ width: collapsed ? COLLAPSED_RAIL_WIDTH : width }}
      >
        {!collapsed ? (
          <EdgeResizeHandle
            edge="left"
            width={width}
            min={WORKSPACE_PANEL_WIDTH_MIN}
            max={WORKSPACE_PANEL_WIDTH_MAX}
            label={t.workspace.sidePanelResize}
            onResize={resize}
            onResizeEnd={commitWidth}
          />
        ) : null}
        <PanelDock
          panels={availablePanels}
          panelTitles={panelTitles}
          activePanelId={activePanel.id}
          navigationLabel={t.workspace.sidePanelNavigation}
          switchLabel={t.workspace.sidePanelSwitch}
          onSelect={selectPanel}
        />
        {!collapsed ? (
          <div className="min-w-0 flex-1">{panelContent('collapse', () => setCollapsed(true))}</div>
        ) : null}
      </aside>
    );
  }

  return (
    <>
      <button
        ref={mobileTriggerRef}
        type="button"
        onClick={() => setMobileOpen(true)}
        aria-label={t.workspace.sidePanelOpen}
        title={t.workspace.sidePanelOpen}
        className="fixed bottom-24 right-3 z-30 flex size-11 items-center justify-center rounded-2xl border border-outline-variant/25 bg-surface-container-high text-on-surface shadow-xl transition-all hover:border-primary/40 hover:text-primary active:scale-95 motion-reduce:transition-none"
      >
        <PanelRightOpen size={19} />
      </button>
      {mobileOpen ? (
        <>
          <div
            aria-hidden="true"
            onClick={closeMobile}
            className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
          />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label={t.workspace.sidePanelTitle}
            className="fixed inset-y-0 right-0 z-50 flex w-[min(92vw,24rem)] border-l border-outline-variant/20 bg-surface-container-low shadow-2xl"
          >
            <PanelDock
              panels={availablePanels}
              panelTitles={panelTitles}
              activePanelId={activePanel.id}
              navigationLabel={t.workspace.sidePanelNavigation}
              switchLabel={t.workspace.sidePanelSwitch}
              onSelect={selectPanel}
            />
            <div className="min-w-0 flex-1">
              {panelContent('close', closeMobile, mobileCloseRef)}
            </div>
          </aside>
        </>
      ) : null}
    </>
  );
}

interface PanelDockProps {
  readonly panels: readonly RailPanelDefinition[];
  readonly panelTitles: Readonly<Record<WorkspacePanelId, string>>;
  readonly activePanelId: WorkspacePanelId;
  readonly navigationLabel: string;
  readonly switchLabel: string;
  readonly onSelect: (panelId: WorkspacePanelId) => void;
}

function PanelDock({
  panels,
  panelTitles,
  activePanelId,
  navigationLabel,
  switchLabel,
  onSelect,
}: PanelDockProps) {
  return (
    <nav
      aria-label={navigationLabel}
      className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-outline-variant/15 bg-surface-container-lowest py-2"
    >
      {panels.map((panel) => {
        const Icon = panel.icon;
        const title = panelTitles[panel.id];
        const active = panel.id === activePanelId;
        return (
          <Button
            key={panel.id}
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => onSelect(panel.id)}
            aria-label={switchLabel.replace('{panel}', title)}
            aria-pressed={active}
            title={title}
            className={`relative size-10 focus-visible:outline-2 focus-visible:outline-primary ${
              active
                ? 'bg-primary/12 text-primary hover:bg-primary/15 hover:text-primary'
                : 'text-on-surface-variant'
            }`}
          >
            {active ? (
              <span className="absolute -left-1 h-5 w-0.5 rounded-r-full bg-primary" />
            ) : null}
            <Icon size={18} />
          </Button>
        );
      })}
    </nav>
  );
}

function useDesktopRail(): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(DESKTOP_RAIL_QUERY).matches);

  useEffect(() => {
    const mediaQuery = window.matchMedia(DESKTOP_RAIL_QUERY);
    const handleChange = () => setMatches(mediaQuery.matches);
    mediaQuery.addEventListener('change', handleChange);
    handleChange();
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  return matches;
}
