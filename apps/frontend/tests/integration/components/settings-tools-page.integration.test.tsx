/**
 * Integration tests for tools settings page.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';

import userEvent from '@testing-library/user-event';

import { ToolSettingsPage } from '../../../src/features/settings/tools/components/ToolSettingsPage';
import { act, fireEvent, render, screen, waitFor } from '../../support/harness/render';
import { advanceTimersByTimeAsync, useFakeTimers } from '../../support/harness/timers';
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
  ],
};

describe('ToolSettingsPage integration', () => {
  const fetchScenario = createFetchScenario();
  const setMaxToolIterations = jest.fn();

  beforeEach(() => {
    fetchScenario.install();
  });

  afterEach(() => {
    fetchScenario.restore();
  });

  for (const status of [200, 500]) {
    it(`keeps a new numeric draft when an older save settles with ${status}`, async () => {
      const descriptor = {
        ...TOOLS_RESPONSE.tools[0],
        parameters: { timeout: 60 },
        parameterDescriptors: [
          {
            name: 'timeout',
            label: 'Timeout',
            type: 'number',
            required: false,
            defaultValue: 60,
            min: 5,
            max: 600,
          },
        ],
      };
      fetchScenario.respondWithJson('GET', '/api/settings/tools', {
        body: { tools: [descriptor] },
      });
      const response = Promise.withResolvers<Response>();
      const originalFetch = fetchScenario.fetchMock.getMockImplementation();
      if (!originalFetch) throw new Error('Expected a registered fetch scenario');
      let writes = 0;
      fetchScenario.fetchMock.mockImplementation((input, init) => {
        const method = input instanceof Request ? input.method : init?.method;
        if (method === 'PUT') {
          writes++;
          if (writes === 1) return response.promise;
          return Promise.resolve(Response.json({ ...descriptor, parameters: { timeout: 200 } }));
        }
        return originalFetch(input, init);
      });
      render(
        <ToolSettingsPage maxToolIterations={10} setMaxToolIterations={setMaxToolIterations} />
      );
      const input = await screen.findByRole('spinbutton', { name: 'Timeout' });
      useFakeTimers();
      fireEvent.change(input, { target: { value: '100' } });
      fireEvent.blur(input);
      await act(async () => {
        await advanceTimersByTimeAsync(400);
      });
      expect(writes).toBe(1);
      fireEvent.change(input, { target: { value: '2' } });
      await act(async () => {
        response.resolve(
          Response.json(
            status === 200
              ? { ...descriptor, parameters: { timeout: 100 } }
              : { message: 'Save failed' },
            { status }
          )
        );
        await response.promise;
      });
      // Deliver React Query's notification before advancing the autosave clock.
      await act(async () => {
        await advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        await advanceTimersByTimeAsync(400);
      });
      expect(input).toHaveValue(2);
      expect(writes).toBe(1);
      fireEvent.change(input, { target: { value: '200' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await act(async () => {
        await advanceTimersByTimeAsync(400);
      });
      expect(writes).toBe(2);
      expect(input).toHaveValue(200);
    });
  }

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
