/**
 * Integration tests for tools settings page.
 */

import userEvent from '@testing-library/user-event';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '../../support/harness/render';
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
  ],
};

describe('ToolSettingsPage integration', () => {
  const fetchScenario = createFetchScenario();
  const setMaxToolIterations = vi.fn();

  beforeEach(() => {
    fetchScenario.install();
  });

  afterEach(() => {
    fetchScenario.restore();
  });

  it('loads and displays tool descriptors grouped by category', async () => {
    fetchScenario.respondWithJson('GET', '/api/settings/tools', {
      body: TOOLS_RESPONSE,
    });

    render(<ToolSettingsPage maxToolIterations={10} setMaxToolIterations={setMaxToolIterations} />);

    await screen.findByText('Current date and time');
    expect(screen.getByText('System')).toBeInTheDocument();
    expect(screen.getByText('Image')).toBeInTheDocument();
    expect(screen.getByText('Image Generation')).toBeInTheDocument();
  });

  it('autosaves parameter changes via PUT endpoint', async () => {
    const user = userEvent.setup();

    fetchScenario.respondWithJson('GET', '/api/settings/tools', {
      body: TOOLS_RESPONSE,
    });

    render(<ToolSettingsPage maxToolIterations={10} setMaxToolIterations={setMaxToolIterations} />);

    await screen.findByText('Current date and time');

    // Change the timezone parameter
    const timezoneInput = screen.getByDisplayValue('UTC');
    await user.clear(timezoneInput);
    await user.type(timezoneInput, 'America/New_York');

    // Register PUT response for autosave
    fetchScenario.respondWithJson('PUT', '/api/settings/tools/get_current_datetime', {
      body: {},
    });

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
});
