/**
 * Unit tests for ToolSettingsPage component.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../support/harness/render';
import { createFetchScenario } from '../../support/mocks/create-fetch-scenario';
import { ToolSettingsPage } from '../../../src/features/settings/tools/components/ToolSettingsPage';

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
  const setMaxToolIterations = vi.fn();

  beforeEach(() => {
    fetchScenario.install();
  });

  afterEach(() => {
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

    await vi.waitFor(() => {
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

  it('renders save button for tools with parameters', async () => {
    fetchScenario.respondWithJson('GET', '/api/settings/tools', {
      body: TOOLS_RESPONSE,
    });

    render(<ToolSettingsPage maxToolIterations={10} setMaxToolIterations={setMaxToolIterations} />);

    await screen.findByText('Current date and time');

    const saveButtons = screen.getAllByText('Save');
    // At least the parameter save button exists
    expect(saveButtons.length).toBeGreaterThanOrEqual(1);
  });
});
