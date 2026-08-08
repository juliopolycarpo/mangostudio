/**
 * Integration tests for app-level settings pages backed by /api/settings/app.
 */

import { type AppSettings, DEFAULT_APP_SETTINGS } from '@mangostudio/shared/app-settings';
import { fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GeneralSettings } from '../../../src/components/settings/GeneralSettings';
import { PromptSettings } from '../../../src/components/settings/PromptSettings';
import { useGlobalSettings } from '../../../src/hooks/use-global-settings';
import { render, screen, waitFor } from '../../support/harness/render';
import { createFetchScenario } from '../../support/mocks/create-fetch-scenario';

const TITLE_MODELS = [
  {
    modelId: 'title-model',
    resourceName: 'title-model',
    displayName: 'Title Model',
    supportedActions: ['text'],
  },
];

function PromptSettingsHarness() {
  const settings = useGlobalSettings();

  return (
    <PromptSettings
      promptSettings={settings.promptSettings}
      onTextSystemPromptChange={settings.setTextSystemPrompt}
      onImageSystemPromptChange={settings.setImageSystemPrompt}
      onUpdateRuleFile={settings.updateRuleFileSetting}
      onAddCustomRule={settings.addCustomRule}
      onRemoveCustomRule={settings.removeCustomRule}
    />
  );
}

function GeneralSettingsHarness() {
  const settings = useGlobalSettings();

  return (
    <GeneralSettings
      imageQuality={settings.globalImageQuality}
      setImageQuality={settings.setGlobalImageQuality}
      chatTitleSettings={settings.chatTitleSettings}
      availableTitleModels={TITLE_MODELS}
      setChatAutoRenameEnabled={settings.setChatAutoRenameEnabled}
      setChatTitleStrategy={settings.setChatTitleStrategy}
      setChatTitlePromptPrefixLength={settings.setChatTitlePromptPrefixLength}
      setPreferredChatTitleModel={settings.setPreferredChatTitleModel}
      multiAgentSettings={settings.multiAgentSettings}
      setMultiAgentEnabled={settings.setMultiAgentEnabled}
      setTraceVisibility={settings.setTraceVisibility}
      setMaxDelegationDepth={settings.setMaxDelegationDepth}
      setMaxSubagentCalls={settings.setMaxSubagentCalls}
      setSubagentTimeoutMs={settings.setSubagentTimeoutMs}
      setDefaultSubagentMaxTurns={settings.setDefaultSubagentMaxTurns}
      workspaceSettings={settings.workspaceSettings}
      setDefaultWorkdir={settings.setDefaultWorkdir}
      setRestrictToolsToWorkdir={settings.setRestrictToolsToWorkdir}
      setWorkspacePanelVisible={settings.setWorkspacePanelVisible}
      moveWorkspacePanel={settings.moveWorkspacePanel}
      setWorkspacePanelWidth={settings.setWorkspacePanelWidth}
      setChatSidebarWidth={settings.setChatSidebarWidth}
      addRecentWorkdir={settings.addRecentWorkdir}
    />
  );
}

function getLatestRequestBody(
  fetchCalls: Array<readonly [input: RequestInfo | URL, init?: RequestInit]>,
  path: string,
  method: string
): AppSettings {
  const matchingCall = [...fetchCalls].reverse().find((call) => {
    const input = call[0];
    const init = call[1];
    const requestMethod = input instanceof Request ? input.method : (init?.method ?? 'GET');
    const requestUrl = input instanceof Request ? input.url : String(input);

    return (
      requestMethod.toUpperCase() === method.toUpperCase() &&
      new URL(requestUrl, 'http://localhost').pathname === path
    );
  });

  if (!matchingCall) {
    throw new Error(`Expected ${method.toUpperCase()} ${path} to be called.`);
  }

  const init = matchingCall[1];
  if (!init?.body || typeof init.body !== 'string') {
    throw new Error(`Expected ${method.toUpperCase()} ${path} to include a JSON body.`);
  }

  return JSON.parse(init.body) as AppSettings;
}

describe('app settings pages integration', () => {
  const fetchScenario = createFetchScenario();

  beforeEach(() => {
    window.localStorage.setItem('mangostudio:locale', 'en');
    fetchScenario.install();
  });

  afterEach(() => {
    fetchScenario.restore();
    window.localStorage.clear();
  });

  it('loads prompt settings from /api/settings/app, saves edits, and reads them back after remount', async () => {
    const initialSettings: AppSettings = {
      ...DEFAULT_APP_SETTINGS,
      promptSettings: {
        ...DEFAULT_APP_SETTINGS.promptSettings,
        textSystemPrompt: 'Initial prompt from API',
      },
    };

    fetchScenario.respondWithJson('GET', '/api/settings/app', {
      body: initialSettings,
    });

    const view = render(<PromptSettingsHarness />);

    const textPrompt = await screen.findByLabelText('Default Text System Prompt');
    await waitFor(() => {
      expect(textPrompt).toHaveValue('Initial prompt from API');
    });

    fetchScenario.respondWithJson('PUT', '/api/settings/app', {
      body: {
        ...initialSettings,
        promptSettings: {
          ...initialSettings.promptSettings,
          textSystemPrompt: 'Updated prompt from UI',
        },
      },
    });

    fireEvent.change(textPrompt, { target: { value: 'Updated prompt from UI' } });

    await waitFor(() => {
      const body = getLatestRequestBody(
        fetchScenario.fetchMock.mock.calls,
        '/api/settings/app',
        'PUT'
      );

      expect(body.promptSettings.textSystemPrompt).toBe('Updated prompt from UI');
      expect(body.globalImageQuality).toBe(DEFAULT_APP_SETTINGS.globalImageQuality);
    });

    const persistedSettings = getLatestRequestBody(
      fetchScenario.fetchMock.mock.calls,
      '/api/settings/app',
      'PUT'
    );

    fetchScenario.respondWithJson('GET', '/api/settings/app', {
      body: persistedSettings,
    });

    view.unmount();
    render(<PromptSettingsHarness />);

    await waitFor(() => {
      expect(screen.getByLabelText('Default Text System Prompt')).toHaveValue(
        'Updated prompt from UI'
      );
    });
  });

  it('loads general settings from /api/settings/app and persists image quality changes', async () => {
    const user = userEvent.setup();
    const initialSettings: AppSettings = {
      ...DEFAULT_APP_SETTINGS,
      globalImageQuality: '2K',
    };

    fetchScenario.respondWithJson('GET', '/api/settings/app', {
      body: initialSettings,
    });
    fetchScenario.respondWithJson('PUT', '/api/settings/app', {
      body: {
        ...initialSettings,
        globalImageQuality: '4K',
      },
    });

    render(<GeneralSettingsHarness />);

    await screen.findByText('Default Image Quality');

    await user.click(screen.getByRole('button', { name: '4K' }));

    await waitFor(() => {
      const body = getLatestRequestBody(
        fetchScenario.fetchMock.mock.calls,
        '/api/settings/app',
        'PUT'
      );

      expect(body.globalImageQuality).toBe('4K');
      expect(body.promptSettings).toEqual(DEFAULT_APP_SETTINGS.promptSettings);
    });
  });

  it('persists chat title auto rename decisions from general settings', async () => {
    const initialSettings: AppSettings = {
      ...DEFAULT_APP_SETTINGS,
      chatTitleSettings: {
        ...DEFAULT_APP_SETTINGS.chatTitleSettings,
        promptPrefixLength: 30,
      },
    };

    fetchScenario.respondWithJson('GET', '/api/settings/app', {
      body: initialSettings,
    });
    fetchScenario.respondWithJson('PUT', '/api/settings/app', {
      body: {
        ...initialSettings,
        chatTitleSettings: {
          autoRenameEnabled: false,
          strategy: 'prompt_prefix',
          promptPrefixLength: 30,
          preferredModel: 'current_model',
        },
      },
    });

    render(<GeneralSettingsHarness />);

    const autoRenameToggle = await screen.findByLabelText('Auto rename new chats');
    fireEvent.click(autoRenameToggle);

    await waitFor(() => {
      const body = getLatestRequestBody(
        fetchScenario.fetchMock.mock.calls,
        '/api/settings/app',
        'PUT'
      );

      expect(body.chatTitleSettings.autoRenameEnabled).toBe(false);
      expect(body.chatTitleSettings.promptPrefixLength).toBe(30);
    });
  });

  it('persists model title source decisions from general settings', async () => {
    const user = userEvent.setup();
    const initialSettings: AppSettings = {
      ...DEFAULT_APP_SETTINGS,
      chatTitleSettings: {
        ...DEFAULT_APP_SETTINGS.chatTitleSettings,
        strategy: 'prompt_prefix',
        preferredModel: 'current_model',
      },
    };

    fetchScenario.respondWithJson('GET', '/api/settings/app', {
      body: initialSettings,
    });
    fetchScenario.respondWithJson('PUT', '/api/settings/app', {
      body: {
        ...initialSettings,
        chatTitleSettings: {
          ...initialSettings.chatTitleSettings,
          strategy: 'model',
        },
      },
    });

    render(<GeneralSettingsHarness />);

    await user.selectOptions(await screen.findByLabelText('Title source'), 'model');

    await waitFor(() => {
      const body = getLatestRequestBody(
        fetchScenario.fetchMock.mock.calls,
        '/api/settings/app',
        'PUT'
      );

      expect(body.chatTitleSettings.strategy).toBe('model');
      expect(body.chatTitleSettings.preferredModel).toBe('current_model');
    });

    fetchScenario.respondWithJson('PUT', '/api/settings/app', {
      body: {
        ...initialSettings,
        chatTitleSettings: {
          ...initialSettings.chatTitleSettings,
          strategy: 'model',
          preferredModel: 'title-model',
        },
      },
    });

    await user.selectOptions(await screen.findByLabelText('Title model'), 'title-model');

    await waitFor(() => {
      const body = getLatestRequestBody(
        fetchScenario.fetchMock.mock.calls,
        '/api/settings/app',
        'PUT'
      );

      expect(body.chatTitleSettings.strategy).toBe('model');
      expect(body.chatTitleSettings.preferredModel).toBe('title-model');
    });
  });

  it('persists side panel visibility, order, and width controls', async () => {
    const user = userEvent.setup();
    const initialSettings: AppSettings = {
      ...DEFAULT_APP_SETTINGS,
      workspaceSettings: {
        ...DEFAULT_APP_SETTINGS.workspaceSettings,
        sidePanel: {
          ...DEFAULT_APP_SETTINGS.workspaceSettings.sidePanel,
          width: 420,
        },
      },
    };
    const visibilitySettings: AppSettings = {
      ...initialSettings,
      workspaceSettings: {
        ...initialSettings.workspaceSettings,
        sidePanel: {
          visiblePanelIds: ['todos'],
          panelOrder: ['git', 'todos'],
          width: 420,
        },
      },
    };
    const orderedSettings: AppSettings = {
      ...visibilitySettings,
      workspaceSettings: {
        ...visibilitySettings.workspaceSettings,
        sidePanel: {
          ...visibilitySettings.workspaceSettings.sidePanel,
          panelOrder: ['todos', 'git'],
        },
      },
    };
    const expectedSettings: AppSettings = {
      ...orderedSettings,
      workspaceSettings: {
        ...orderedSettings.workspaceSettings,
        sidePanel: {
          ...orderedSettings.workspaceSettings.sidePanel,
          width: 360,
        },
      },
    };

    fetchScenario.respondWithJson('GET', '/api/settings/app', { body: initialSettings });
    fetchScenario.respondWithJson('PUT', '/api/settings/app', { body: visibilitySettings });

    render(<GeneralSettingsHarness />);

    await screen.findByText('Current width: 420px');
    await user.click(await screen.findByLabelText('Show Repository'));

    await waitFor(() => {
      const body = getLatestRequestBody(
        fetchScenario.fetchMock.mock.calls,
        '/api/settings/app',
        'PUT'
      );
      expect(body.workspaceSettings.sidePanel).toEqual(
        visibilitySettings.workspaceSettings.sidePanel
      );
    });

    fetchScenario.respondWithJson('PUT', '/api/settings/app', { body: orderedSettings });
    await user.click(screen.getByRole('button', { name: 'Move Task list up' }));

    await waitFor(() => {
      const body = getLatestRequestBody(
        fetchScenario.fetchMock.mock.calls,
        '/api/settings/app',
        'PUT'
      );
      expect(body.workspaceSettings.sidePanel).toEqual(orderedSettings.workspaceSettings.sidePanel);
    });

    fetchScenario.respondWithJson('PUT', '/api/settings/app', { body: expectedSettings });
    await user.click(screen.getByRole('button', { name: 'Reset width' }));

    await waitFor(() => {
      const body = getLatestRequestBody(
        fetchScenario.fetchMock.mock.calls,
        '/api/settings/app',
        'PUT'
      );
      expect(body.workspaceSettings.sidePanel).toEqual(
        expectedSettings.workspaceSettings.sidePanel
      );
    });
  });
});
