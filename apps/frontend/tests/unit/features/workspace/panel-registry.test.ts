import { describe, expect, it } from 'bun:test';
import { DEFAULT_WORKSPACE_SETTINGS } from '@mangostudio/shared/app-settings';
import {
  getAvailableWorkspacePanels,
  WORKSPACE_PANEL_REGISTRY,
} from '../../../../src/features/workspace/rail/panel-registry';

describe('workspace panel registry', () => {
  it('keeps Git limited to chats with a working directory', () => {
    const panel = WORKSPACE_PANEL_REGISTRY.find(({ id }) => id === 'git');
    expect(panel).toBeDefined();

    expect(
      panel?.availability({
        chatId: 'chat-1',
        workdir: '/srv/projects/mango',
        todoCount: 0,
      })
    ).toBe(true);
    expect(
      panel?.availability({
        chatId: 'chat-1',
        workdir: null,
        todoCount: 0,
      })
    ).toBe(false);
  });

  it('offers GitHub on a chat alone, with or without a working directory', () => {
    const panel = WORKSPACE_PANEL_REGISTRY.find(({ id }) => id === 'github');
    expect(panel).toBeDefined();

    // Unlike Git: the panel's upper half is the cross-repository review queue,
    // which is about the person rather than a checkout. Requiring a workdir
    // would hide a full inbox from anybody whose chat has no folder yet.
    expect(panel?.availability({ chatId: 'chat-1', workdir: null, todoCount: 0 })).toBe(true);
    expect(
      panel?.availability({ chatId: 'chat-1', workdir: '/srv/projects/mango', todoCount: 0 })
    ).toBe(true);
    expect(panel?.availability({ chatId: null, workdir: null, todoCount: 0 })).toBe(false);
  });

  it('shows tasks only when a chat has todo state', () => {
    const panel = WORKSPACE_PANEL_REGISTRY.find(({ id }) => id === 'todos');
    expect(panel).toBeDefined();

    expect(
      panel?.availability({
        chatId: 'chat-1',
        workdir: null,
        todoCount: 2,
      })
    ).toBe(true);
    expect(
      panel?.availability({
        chatId: 'chat-1',
        workdir: null,
        todoCount: 0,
      })
    ).toBe(false);
  });

  it('resolves visible panels in the persisted order', () => {
    const panels = getAvailableWorkspacePanels(
      {
        chatId: 'chat-1',
        workdir: '/srv/projects/mango',
        todoCount: 2,
      },
      {
        ...DEFAULT_WORKSPACE_SETTINGS.sidePanel,
        visiblePanelIds: ['todos'],
        panelOrder: ['todos', 'git'],
      }
    );

    expect(panels.map(({ id }) => id)).toEqual(['todos']);
  });

  it('ships all three panels visible by default', () => {
    const panels = getAvailableWorkspacePanels(
      { chatId: 'chat-1', workdir: '/srv/projects/mango', todoCount: 2 },
      DEFAULT_WORKSPACE_SETTINGS.sidePanel
    );

    expect(panels.map(({ id }) => id)).toEqual(['git', 'github', 'todos']);
  });

  it('hides GitHub when the user turned it off', () => {
    const panels = getAvailableWorkspacePanels(
      { chatId: 'chat-1', workdir: null, todoCount: 0 },
      {
        ...DEFAULT_WORKSPACE_SETTINGS.sidePanel,
        visiblePanelIds: ['git', 'todos'],
      }
    );

    expect(panels.map(({ id }) => id)).toEqual([]);
  });
});
