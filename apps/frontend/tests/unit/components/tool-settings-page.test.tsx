/**
 * Unit tests for ToolSettingsPage component.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import userEvent from '@testing-library/user-event';
import { ToolSettingsPage } from '../../../src/features/settings/tools/components/ToolSettingsPage';
import { act, fireEvent, render, screen, waitFor } from '../../support/harness/render';
import {
  advanceTimersByTimeAsync,
  restoreRealTimers,
  useFakeTimers,
} from '../../support/harness/timers';
import { createFetchScenario } from '../../support/mocks/create-fetch-scenario';

const TOOLS_RESPONSE = {
  tools: [
    {
      name: 'get_current_datetime',
      title: 'Current date and time',
      description: 'Returns the current date and time.',
      category: 'system',
      enabled: true,
      canDisable: true,
      parameters: { timezone: 'UTC' },
      parameterDescriptors: [
        {
          name: 'timezone',
          label: 'Default timezone',
          type: 'string',
          required: true,
          defaultValue: 'UTC',
        },
      ],
    },
    {
      name: 'image_generation',
      title: 'Image Generation',
      description: 'Generate images from text descriptions.',
      category: 'image',
      enabled: false,
      canDisable: true,
      parameters: {},
      parameterDescriptors: [],
    },
    {
      name: 'web_search',
      title: 'Web Search',
      description: 'Search the web for information.',
      category: 'interaction',
      enabled: true,
      canDisable: false,
      parameters: {},
      parameterDescriptors: [],
    },
  ],
};

describe('ToolSettingsPage', () => {
  const fetchScenario = createFetchScenario();
  const setMaxToolIterations = jest.fn();

  beforeEach(() => {
    fetchScenario.install();
  });

  afterEach(async () => {
    await restoreRealTimers();
    fetchScenario.restore();
  });

  it('shows loading state', () => {
    render(<ToolSettingsPage maxToolIterations={10} setMaxToolIterations={setMaxToolIterations} />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('shows error state with retry button', async () => {
    fetchScenario.respondWithJson('GET', '/api/settings/tools', {
      status: 500,
      body: { error: 'Failed to load tools' },
    });

    render(<ToolSettingsPage maxToolIterations={10} setMaxToolIterations={setMaxToolIterations} />);

    const retryButton = await screen.findByText(/retry/i);
    expect(retryButton).toBeInTheDocument();
  });

  it('renders tools grouped by category', async () => {
    fetchScenario.respondWithJson('GET', '/api/settings/tools', {
      body: TOOLS_RESPONSE,
    });

    render(<ToolSettingsPage maxToolIterations={10} setMaxToolIterations={setMaxToolIterations} />);

    await screen.findByText('Current date and time');
    expect(screen.getByText('Current date and time')).toBeInTheDocument();
    expect(screen.getByText('Image Generation')).toBeInTheDocument();
    expect(screen.getByText('Web Search')).toBeInTheDocument();

    expect(screen.getByText('System')).toBeInTheDocument();
    expect(screen.getByText('Image')).toBeInTheDocument();
    expect(screen.getByText('Interaction')).toBeInTheDocument();
  });

  it('uses localized names and descriptions for file mutation tools', async () => {
    fetchScenario.respondWithJson('GET', '/api/settings/tools', {
      body: {
        tools: [
          'edit_file',
          'replace_range',
          'apply_patch',
          'create_file',
          'delete_file',
          'move_file',
        ].map((name) => ({
          name,
          title: `Server title for ${name}`,
          description: `Server description for ${name}`,
          category: 'system',
          enabled: true,
          canDisable: true,
          parameters: {},
          parameterDescriptors: [],
        })),
      },
    });

    render(<ToolSettingsPage maxToolIterations={10} setMaxToolIterations={setMaxToolIterations} />);

    expect(await screen.findByText('Create file')).toBeInTheDocument();
    expect(screen.getByText('Edit file')).toBeInTheDocument();
    expect(screen.getByText('Replace range')).toBeInTheDocument();
    expect(screen.getByText('Apply patch')).toBeInTheDocument();
    expect(screen.getByText('Delete file')).toBeInTheDocument();
    expect(screen.getByText('Move file')).toBeInTheDocument();
    expect(
      screen.getByText('Allows the AI to create new text files without overwriting existing paths.')
    ).toBeInTheDocument();
    expect(screen.queryByText(/Server title/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Server description/)).not.toBeInTheDocument();
  });

  it('shows cannot-disable text for tools that cannot be disabled', async () => {
    fetchScenario.respondWithJson('GET', '/api/settings/tools', {
      body: TOOLS_RESPONSE,
    });

    render(<ToolSettingsPage maxToolIterations={10} setMaxToolIterations={setMaxToolIterations} />);

    await screen.findByText('Current date and time');
    expect(screen.getByText(/cannot be disabled/i)).toBeInTheDocument();
  });

  it('renders the max tool iterations control', async () => {
    fetchScenario.respondWithJson('GET', '/api/settings/tools', {
      body: TOOLS_RESPONSE,
    });

    render(<ToolSettingsPage maxToolIterations={7} setMaxToolIterations={setMaxToolIterations} />);

    await screen.findByText('Current date and time');
    expect(screen.getAllByLabelText(/max tool iterations/i).length).toBeGreaterThanOrEqual(1);
  });

  it('renders string parameter field with default value', async () => {
    fetchScenario.respondWithJson('GET', '/api/settings/tools', {
      body: TOOLS_RESPONSE,
    });

    render(<ToolSettingsPage maxToolIterations={10} setMaxToolIterations={setMaxToolIterations} />);

    await screen.findByText('Current date and time');

    const timezoneInput = screen.getByDisplayValue('UTC');
    expect(timezoneInput).toBeInTheDocument();
  });

  it('calls setMaxToolIterations when slider changes', async () => {
    const user = userEvent.setup();

    fetchScenario.respondWithJson('GET', '/api/settings/tools', {
      body: TOOLS_RESPONSE,
    });

    render(<ToolSettingsPage maxToolIterations={10} setMaxToolIterations={setMaxToolIterations} />);

    await screen.findByText('Current date and time');

    const numberInput = screen.getAllByLabelText(/max tool iterations/i)[1];
    await user.clear(numberInput);
    await user.type(numberInput, '15');

    expect(setMaxToolIterations).toHaveBeenCalled();
  });

  it('calls PUT endpoint when toggling a tool', async () => {
    const user = userEvent.setup();

    fetchScenario.respondWithJson('GET', '/api/settings/tools', {
      body: TOOLS_RESPONSE,
    });

    render(<ToolSettingsPage maxToolIterations={10} setMaxToolIterations={setMaxToolIterations} />);

    await screen.findByText('Current date and time');

    fetchScenario.respondWithJson('PUT', '/api/settings/tools/get_current_datetime', {
      body: {},
    });

    const checkbox = screen.getAllByRole('checkbox')[0];
    await user.click(checkbox);

    await waitFor(() => {
      const putCalls = fetchScenario.fetchMock.mock.calls.filter((call: unknown[]) => {
        const input = call[0];
        const init = call[1] as RequestInit | undefined;
        const method = input instanceof Request ? input.method : init?.method;
        const url = input instanceof Request ? input.url : String(input);
        return (
          method === 'PUT' &&
          new URL(url, 'http://localhost').pathname === '/api/settings/tools/get_current_datetime'
        );
      });
      expect(putCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('does not render a save button for tools with parameters', async () => {
    fetchScenario.respondWithJson('GET', '/api/settings/tools', {
      body: TOOLS_RESPONSE,
    });

    render(<ToolSettingsPage maxToolIterations={10} setMaxToolIterations={setMaxToolIterations} />);

    await screen.findByText('Current date and time');

    expect(screen.queryByText('Save')).not.toBeInTheDocument();
  });

  it('ignores failed autosave results after unmount', async () => {
    const originalWindow = window;
    let rejectToolUpdate: ((reason?: unknown) => void) | undefined;

    const fetchMock = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const method = input instanceof Request ? input.method : init?.method;
      const url = input instanceof Request ? input.url : String(input);
      const path = new URL(url, 'http://localhost').pathname;

      if ((method ?? 'GET').toUpperCase() === 'GET' && path === '/api/settings/tools') {
        return Promise.resolve(
          new Response(JSON.stringify(TOOLS_RESPONSE), {
            headers: { 'Content-Type': 'application/json' },
          })
        );
      }

      if (method === 'PUT' && path === '/api/settings/tools/get_current_datetime') {
        return new Promise<Response>((_, reject) => {
          rejectToolUpdate = reject;
        });
      }

      return Promise.reject(new Error(`Unhandled request: ${method ?? 'GET'} ${path}`));
    });

    // `vi.stubGlobal` has no `bun test` equivalent; the original is captured and
    // put back by hand below.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { unmount } = render(
      <ToolSettingsPage maxToolIterations={10} setMaxToolIterations={setMaxToolIterations} />
    );

    await screen.findByText('Current date and time');

    useFakeTimers();
    fireEvent.change(screen.getByDisplayValue('UTC'), {
      target: { value: 'Europe/Lisbon' },
    });

    await act(async () => {
      await advanceTimersByTimeAsync(350);
    });

    if (!rejectToolUpdate) throw new Error('Expected autosave PUT request');

    unmount();

    try {
      // The point of the test: the autosave rejection handler must survive a
      // teardown that has already taken `window` away.
      (globalThis as { window?: Window }).window = undefined;
      rejectToolUpdate(new Error('save failed'));
      for (let index = 0; index < 5; index += 1) {
        await Promise.resolve();
      }
    } finally {
      (globalThis as { window?: Window }).window = originalWindow;
      globalThis.fetch = originalFetch;
    }

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/settings/tools/get_current_datetime'),
      expect.objectContaining({ method: 'PUT' })
    );
  });

  it('renders model selector when parameter has modelType image', async () => {
    const TOOLS_WITH_MODEL_SELECTOR = {
      tools: [
        {
          name: 'generate_image',
          title: 'Image generation',
          description: 'Generate images from text.',
          category: 'image',
          enabled: true,
          canDisable: true,
          parameters: { defaultModel: 'auto' },
          parameterDescriptors: [
            {
              name: 'defaultModel',
              label: 'Default image model',
              description: 'Use "auto" to select the first available image model.',
              type: 'string',
              required: true,
              defaultValue: 'auto',
              modelType: 'image',
            },
          ],
        },
      ],
    };

    const CATALOG_RESPONSE = {
      configured: true,
      status: 'ready',
      allModels: [],
      textModels: [],
      imageModels: [
        {
          modelId: 'imagen-3',
          resourceName: 'imagen-3',
          displayName: 'Imagen 3',
          description: 'Google image model',
          version: '1',
          supportedActions: ['image_generation'],
          provider: 'google',
          capabilities: { text: false, image: true, streaming: false },
          inputTokenLimit: 0,
        },
        {
          modelId: 'dall-e-3',
          resourceName: 'dall-e-3',
          displayName: 'DALL-E 3',
          description: 'OpenAI image model',
          version: '1',
          supportedActions: ['image_generation'],
          provider: 'openai',
          capabilities: { text: false, image: true, streaming: false },
          inputTokenLimit: 0,
        },
      ],
    };

    fetchScenario.respondWithJson('GET', '/api/settings/tools', {
      body: TOOLS_WITH_MODEL_SELECTOR,
    });
    fetchScenario.respondWithJson('GET', '/api/settings/models', {
      body: CATALOG_RESPONSE,
    });

    render(<ToolSettingsPage maxToolIterations={10} setMaxToolIterations={setMaxToolIterations} />);

    await screen.findByText('Image generation');

    // The select should have "Auto (first available)" as first option
    const select = screen.getByRole('combobox');
    expect(select).toBeInTheDocument();

    // "Auto" option text should be visible
    expect(screen.getByText('Auto (first available)')).toBeInTheDocument();

    // Image model options should be present (findByText waits for async catalog)
    expect(await screen.findByText('Imagen 3')).toBeInTheDocument();
    expect(screen.getByText('DALL-E 3')).toBeInTheDocument();
  });

  it('disables quality dropdown when letAiDecideQuality is checked', async () => {
    const user = userEvent.setup();

    const TOOLS_WITH_LET_AI_DECIDE = {
      tools: [
        {
          name: 'generate_image',
          title: 'Image generation',
          description: 'Generate images from text.',
          category: 'image',
          enabled: true,
          canDisable: true,
          parameters: {
            defaultQuality: '1K',
            letAiDecideQuality: false,
          },
          parameterDescriptors: [
            {
              name: 'letAiDecideQuality',
              label: 'Let AI decide quality',
              description: 'When enabled, the AI can choose different image sizes per request.',
              type: 'boolean',
              required: true,
              defaultValue: false,
            },
            {
              name: 'defaultQuality',
              label: 'Default image quality',
              description: 'Quality used when the model does not request one.',
              type: 'select',
              required: true,
              defaultValue: '1K',
              options: [
                { value: '512px', label: '512px' },
                { value: '1K', label: '1K' },
                { value: '2K', label: '2K' },
                { value: '4K', label: '4K' },
              ],
            },
          ],
        },
      ],
    };

    fetchScenario.respondWithJson('GET', '/api/settings/tools', {
      body: TOOLS_WITH_LET_AI_DECIDE,
    });

    render(<ToolSettingsPage maxToolIterations={10} setMaxToolIterations={setMaxToolIterations} />);

    await screen.findByText('Image generation');

    // Quality select should be enabled initially (letAiDecideQuality is false)
    const qualitySelect = screen.getByRole('combobox');
    expect(qualitySelect).not.toBeDisabled();

    // Check the "Let AI decide quality" checkbox
    const letAiCheckbox = screen.getByLabelText('Let AI decide quality');
    await user.click(letAiCheckbox);

    // Quality select should now be disabled
    expect(qualitySelect).toBeDisabled();
  });
});
