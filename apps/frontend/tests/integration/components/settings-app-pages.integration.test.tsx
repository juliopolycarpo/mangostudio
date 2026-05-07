/**
 * Integration tests for app-level settings pages backed by /api/settings/app.
 */

import userEvent from '@testing-library/user-event';
import { fireEvent } from '@testing-library/react';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@mangostudio/shared/app-settings';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PromptSettings } from '../../../src/components/settings/PromptSettings';
import { GeneralSettings } from '../../../src/components/settings/GeneralSettings';
import { useGlobalSettings } from '../../../src/hooks/use-global-settings';
import { render, screen, waitFor } from '../../support/harness/render';
import { createFetchScenario } from '../../support/mocks/create-fetch-scenario';

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
});
