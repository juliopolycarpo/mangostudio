/**
 * Integration tests for tools settings page.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';

import { chatCapabilitiesKeys } from '../../../src/features/chat/hooks/use-chat-capabilities';
import { ToolSettingsPage } from '../../../src/features/settings/tools/components/ToolSettingsPage';
import { toolSettingsKeys } from '../../../src/features/settings/tools/queries';
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

const TIMEOUT_TOOL_PATH = '/api/settings/tools/get_current_datetime';
const TIMEOUT_TOOL = {
  ...TOOLS_RESPONSE.tools[0],
  parameters: { timeout: 60 },
  parameterDescriptors: [
    { name: 'timeout', label: 'Timeout', type: 'number', required: false, min: 5, max: 600 },
  ],
};

function isTimeoutToolWrite(input: RequestInfo | URL, init?: RequestInit) {
  const method = input instanceof Request ? input.method : init?.method;
  const url = input instanceof Request ? input.url : String(input);
  return method === 'PUT' && new URL(url, 'http://localhost').pathname === TIMEOUT_TOOL_PATH;
}

function tickSettingsClock(milliseconds: number) {
  return act(async () => {
    await advanceTimersByTimeAsync(milliseconds);
  });
}

describe('ToolSettingsPage integration', () => {
  const fetchScenario = createFetchScenario();
  const scenarioImplementation = fetchScenario.fetchMock.getMockImplementation();
  if (!scenarioImplementation) throw new Error('Expected the fetch scenario implementation');
  const defaultFetch = scenarioImplementation;
  const setMaxToolIterations = jest.fn();

  function holdFirstTimeoutSave() {
    fetchScenario.respondWithJson('GET', '/api/settings/tools', {
      body: { tools: [TIMEOUT_TOOL] },
    });
    const pending = Promise.withResolvers<Response>();
    const writes: number[] = [];
    async function respondToTimeoutSave(input: RequestInfo | URL, init?: RequestInit) {
      if (!isTimeoutToolWrite(input, init)) return defaultFetch(input, init);
      const body =
        input instanceof Request
          ? await input.clone().json()
          : JSON.parse(typeof init?.body === 'string' ? init.body : '');
      if (typeof body.enabled === 'boolean') {
        return Response.json({ ...TIMEOUT_TOOL, enabled: body.enabled });
      }
      writes.push(body.parameters.timeout);
      return writes.length === 1
        ? pending.promise
        : Response.json({ ...TIMEOUT_TOOL, parameters: body.parameters });
    }
    fetchScenario.fetchMock.mockImplementation(respondToTimeoutSave);
    return { pending, writes };
  }

  beforeEach(() => {
    fetchScenario.install();
  });

  afterEach(() => {
    fetchScenario.fetchMock.mockImplementation(defaultFetch);
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
      let writes = 0;
      function respondToToolSave(input: RequestInfo | URL, init?: RequestInit) {
        const method = input instanceof Request ? input.method : init?.method;
        const url = input instanceof Request ? input.url : String(input);
        if (
          method === 'PUT' &&
          new URL(url, 'http://localhost').pathname === '/api/settings/tools/get_current_datetime'
        ) {
          writes++;
          if (writes === 1) return response.promise;
          return Promise.resolve(Response.json({ ...descriptor, parameters: { timeout: 200 } }));
        }
        return defaultFetch(input, init);
      }
      fetchScenario.fetchMock.mockImplementation(respondToToolSave);
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

  for (const status of [200, 500]) {
    it(`keeps a committed return to the prior value when the pending save settles with ${status}`, async () => {
      const { pending, writes } = holdFirstTimeoutSave();
      try {
        render(
          <ToolSettingsPage maxToolIterations={10} setMaxToolIterations={setMaxToolIterations} />
        );
        const input = await screen.findByRole('spinbutton', { name: 'Timeout' });
        useFakeTimers();
        fireEvent.change(input, { target: { value: '100' } });
        fireEvent.blur(input);
        await tickSettingsClock(400);
        expect(writes).toEqual([100]);

        fireEvent.change(input, { target: { value: '60' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(input).toHaveValue(60);
        await act(async () => {
          pending.resolve(
            Response.json(
              status === 200
                ? { ...TIMEOUT_TOOL, parameters: { timeout: 100 } }
                : { message: 'Save failed' },
              { status }
            )
          );
          await pending.promise;
        });
        await tickSettingsClock(0);
        await tickSettingsClock(400);
        expect(input).toHaveValue(60);
        expect(writes).toEqual(status === 200 ? [100, 60] : [100]);
      } finally {
        pending.resolve(Response.json(TIMEOUT_TOOL));
      }
    });
  }

  it('adopts a newer remote value while a successful save is still settling', async () => {
    fetchScenario.respondWithJson('GET', '/api/settings/tools', {
      body: { tools: [TIMEOUT_TOOL] },
    });
    fetchScenario.respondWithJson('PUT', TIMEOUT_TOOL_PATH, {
      body: { ...TIMEOUT_TOOL, parameters: { timeout: 100 } },
    });

    const invalidationGate = Promise.withResolvers<null>();
    const clientReady = Promise.withResolvers<ReturnType<typeof useQueryClient>>();
    function PageWithCapabilityQuery() {
      const client = useQueryClient();
      useEffect(() => {
        clientReady.resolve(client);
      }, [client]);
      useQuery({
        queryKey: [...chatCapabilitiesKeys.all, 'delayed-tool-settings-test'],
        initialData: null,
        staleTime: Infinity,
        queryFn: () => invalidationGate.promise,
      });
      return (
        <ToolSettingsPage maxToolIterations={10} setMaxToolIterations={setMaxToolIterations} />
      );
    }

    try {
      render(<PageWithCapabilityQuery />);
      const client = await clientReady.promise;
      const input = await screen.findByRole('spinbutton', { name: 'Timeout' });
      useFakeTimers();
      fireEvent.change(input, { target: { value: '100' } });
      fireEvent.blur(input);
      await tickSettingsClock(400);
      await tickSettingsClock(0);
      expect(client.isMutating()).toBe(1);
      expect(client.getQueryData(toolSettingsKeys.list())).toMatchObject({
        tools: [{ parameters: { timeout: 100 } }],
      });

      await act(async () => {
        client.setQueryData(toolSettingsKeys.list(), {
          tools: [{ ...TIMEOUT_TOOL, parameters: { timeout: 120 } }],
        });
        await advanceTimersByTimeAsync(0);
      });
      expect(input).toHaveValue(120);

      await act(async () => {
        invalidationGate.resolve(null);
        await invalidationGate.promise;
        await advanceTimersByTimeAsync(0);
      });
      await tickSettingsClock(400);
      expect(input).toHaveValue(120);
      const writes = fetchScenario.fetchMock.mock.calls.filter(([input, init]) =>
        isTimeoutToolWrite(input, init)
      );
      expect(writes).toHaveLength(1);
    } finally {
      invalidationGate.resolve(null);
    }
  });

  it('waits for a pending parameter save after toggling the tool off and on', async () => {
    const { pending, writes } = holdFirstTimeoutSave();
    try {
      render(
        <ToolSettingsPage maxToolIterations={10} setMaxToolIterations={setMaxToolIterations} />
      );
      const input = await screen.findByRole('spinbutton', { name: 'Timeout' });
      const toggle = screen.getByRole('switch', { name: 'Current date and time' });
      useFakeTimers();
      fireEvent.change(input, { target: { value: '100' } });
      fireEvent.blur(input);
      await tickSettingsClock(400);
      expect(writes).toEqual([100]);

      fireEvent.click(toggle);
      await tickSettingsClock(0);
      expect(input).toBeDisabled();
      fireEvent.click(toggle);
      await tickSettingsClock(0);
      expect(input).toBeEnabled();

      fireEvent.change(input, { target: { value: '120' } });
      fireEvent.blur(input);
      await tickSettingsClock(400);
      expect(writes).toEqual([100]);
      await act(async () => {
        pending.resolve(Response.json({ ...TIMEOUT_TOOL, parameters: { timeout: 100 } }));
        await pending.promise;
      });
      await tickSettingsClock(0);
      await tickSettingsClock(400);
      expect(writes).toEqual([100, 120]);
      expect(input).toHaveValue(120);
    } finally {
      pending.resolve(Response.json(TIMEOUT_TOOL));
    }
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

    fetchScenario.respondWithJson('PUT', '/api/settings/tools/get_current_datetime', {
      body: { ...TOOLS_RESPONSE.tools[0], parameters: { timezone: 'Europe/Lisbon' } },
    });

    const timezoneInput = screen.getByDisplayValue('UTC');
    await user.clear(timezoneInput);
    await user.type(timezoneInput, 'America/New_York');

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
      expect(timezoneInput).toHaveValue('Europe/Lisbon');
    });
  });
});
