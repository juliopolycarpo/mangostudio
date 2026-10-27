import {
  WORKSPACE_PANEL_WIDTH_MAX,
  WORKSPACE_PANEL_WIDTH_MIN,
  type WorkspacePanelId,
  type WorkspacePanelSettings,
} from '@mangostudio/shared/workspaces';
import { PanelRightOpen } from 'lucide-react';
import { type Ref, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { EdgeResizeHandle } from '@/components/layout/EdgeResizeHandle';
import { Button } from '@/components/ui/Button';
import { SELECTION_BAR } from '@/components/ui/selection-bar';
import { useChatTodos } from '@/features/chat/hooks/use-chat-todos';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_MD, ICON_SM } from '@/lib/icon-sizes';

import { getAvailableWorkspacePanels, type RailPanelDefinition } from './panel-registry';
import { onRailPanelRequest } from './rail-panel-request';
import { readRailCollapsed, writeRailCollapsed } from './rail-state';
import { RailPanel } from './RailPanel';

const DESKTOP_RAIL_QUERY = '(min-width: 1024px)';
const COLLAPSED_RAIL_WIDTH = 48;

interface WorkspaceRailProps {
  readonly chatId: string;
  readonly workdir: string | null;
  /** The machine the chat runs on. Null (the default) before it is known. */
  readonly environmentId?: string | null;
  readonly settings: WorkspacePanelSettings;
  readonly onWidthChange?: (width: number) => void;
  /**
   * Where the drawer's trigger is drawn below the desktop breakpoint: a slot in
   * the composer's tool row, which the chat page owns. Null (the default) draws
   * no trigger — the command palette still opens the drawer — rather than a
   * button floating over the transcript.
   */
  readonly triggerSlot?: HTMLElement | null;
}

export function WorkspaceRail({
  chatId,
  workdir,
  environmentId = null,
  settings,
  onWidthChange,
  triggerSlot = null,
}: WorkspaceRailProps) {
  const { t } = useI18n();
  const todosQuery = useChatTodos(chatId);
  const todos = todosQuery.data?.todos ?? [];
  const panelTitles: Readonly<Record<WorkspacePanelId, string>> = {
    git: t.git.title,
    github: t.github.title,
    todos: t.chat.todo.title,
    terminal: t.terminal.title,
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

  const selectPanel = useCallback(
    (panelId: WorkspacePanelId) => {
      setActivePanelId(panelId);
      // Selecting a panel is a request to *see* it, so a collapsed rail opens.
      // Written through the same storage as the collapse button rather than
      // through `setCollapsed`, which is declared below this callback.
      setCollapsedState(false);
      writeRailCollapsed(chatId, false);
      // Below the desktop breakpoint the rail renders as a drawer gated on
      // `mobileOpen` rather than `collapsed`, so an external request that only
      // cleared `collapsed` picked a panel nothing on screen showed.
      if (!isDesktop) setMobileOpen(true);
    },
    [chatId, isDesktop]
  );

  // The rail has no keyboard shortcut for switching panels, so the command
  // palette and the Repository panel's branch chip are how a panel gets opened
  // from outside. Requests arriving while a panel is not available are dropped
  // by the effect below that re-selects the first available one.
  useEffect(() => onRailPanelRequest(selectPanel), [selectPanel]);

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
      title={activeTitle}
      closeMode={closeMode}
      closeButtonRef={closeButtonRef}
      closeLabel={
        closeMode === 'collapse' ? t.workspace.sidePanelCollapse : t.workspace.sidePanelClose
      }
      onClose={onClose}
    >
      <ActivePanelContent
        chatId={chatId}
        workdir={workdir}
        todos={todos}
        environmentId={environmentId}
      />
    </RailPanel>
  );

  if (isDesktop) {
    return (
      <aside
        aria-label={t.workspace.sidePanelTitle}
        className="relative flex h-full shrink-0 border-l border-stroke bg-surface"
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
          collapsed={collapsed}
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
      {/* The trigger is a tool chip in the composer's own row, reached through
          a portal into the slot the chat page hands down. It used to float over
          the transcript's corner, which cost the transcript a gutter (`pr-16`)
          that the composer and the notices did not share. */}
      {triggerSlot
        ? createPortal(
            <button
              ref={mobileTriggerRef}
              type="button"
              onClick={() => setMobileOpen(true)}
              aria-label={t.workspace.sidePanelOpen}
              title={t.workspace.sidePanelOpen}
              className="composer-chip composer-tool-chip"
            >
              <PanelRightOpen size={ICON_SM} className="shrink-0" />
            </button>,
            triggerSlot
          )
        : null}
      {mobileOpen ? (
        <>
          <div aria-hidden="true" onClick={closeMobile} className="fixed inset-0 z-[45] bg-scrim" />
          <aside
            // eslint-disable-next-line jsx-a11y/prefer-tag-over-role -- This custom dialog owns its focus and dismissal behavior.
            role="dialog"
            aria-modal="true"
            aria-label={t.workspace.sidePanelTitle}
            className="fixed inset-y-0 right-0 z-50 flex w-[min(92vw,24rem)] border-l border-stroke bg-surface"
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
  /**
   * The rail is folded down to this strip, so no panel is on screen. Every icon
   * is idle then: the current-item mark (fill, accent bar, `aria-pressed`) says
   * "this one is open", and showing it on a panel nothing displays reads as a
   * selection the person never made — one that changed from chat to chat.
   */
  readonly collapsed?: boolean;
  readonly navigationLabel: string;
  readonly switchLabel: string;
  readonly onSelect: (panelId: WorkspacePanelId) => void;
}

function PanelDock({
  panels,
  panelTitles,
  activePanelId,
  collapsed = false,
  navigationLabel,
  switchLabel,
  onSelect,
}: PanelDockProps) {
  return (
    <nav
      aria-label={navigationLabel}
      className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-stroke bg-sidebar py-2"
    >
      {panels.map((panel) => {
        const Icon = panel.icon;
        const title = panelTitles[panel.id];
        const active = !collapsed && panel.id === activePanelId;
        return (
          <Button
            key={panel.id}
            type="button"
            variant="subtle"
            size="icon"
            onClick={() => onSelect(panel.id)}
            aria-label={switchLabel.replace('{panel}', title)}
            aria-pressed={active}
            title={title}
            // The current panel's mark is the shared selection bar, moved out to the
            // dock's own edge (`before:-left-2`) like the sidebar's current page: the
            // fill alone would not survive a grayscale screen.
            className={`relative ${
              active
                ? `bg-fill-selected text-fg ${SELECTION_BAR} before:-left-2`
                : 'text-fg-muted enabled:hover:text-fg'
            }`}
          >
            <Icon size={ICON_MD} />
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
