/**
 * Unit tests for ToolSettingsCard reconciling a descriptor that changed under
 * it. The settings realtime channel refetches this list on any tool write,
 * including one made in another tab, so the card is handed descriptors it did
 * not ask for.
 */

import type { ToolSettingsDescriptor } from '@mangostudio/shared/tool-settings';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolSettingsCard } from '../../../src/features/settings/tools/components/ToolSettingsCard';
import { act, fireEvent, render, screen } from '../../support/harness/render';
import { createFetchScenario } from '../../support/mocks/create-fetch-scenario';

const TOOL_PATH = '/api/settings/tools/get_current_datetime';

const DESCRIPTOR: ToolSettingsDescriptor = {
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
};

function withTimezone(timezone: string): ToolSettingsDescriptor {
  return { ...DESCRIPTOR, parameters: { timezone } };
}

describe('ToolSettingsCard', () => {
  const fetchScenario = createFetchScenario();

  function countToolWrites(): number {
    return fetchScenario.fetchMock.mock.calls.filter((call) => {
      const [input, init] = call as [RequestInfo | URL, RequestInit | undefined];
      const method = input instanceof Request ? input.method : init?.method;
      const url = input instanceof Request ? input.url : String(input);
      return method === 'PUT' && new URL(url, 'http://localhost').pathname === TOOL_PATH;
    }).length;
  }

  beforeEach(() => {
    fetchScenario.install();
  });

  afterEach(() => {
    vi.useRealTimers();
    fetchScenario.restore();
  });

  it('adopts a remote parameter change instead of saving the stale one back', async () => {
    const { rerender } = render(<ToolSettingsCard descriptor={DESCRIPTOR} />);

    expect(screen.getByDisplayValue('UTC')).toBeInTheDocument();

    vi.useFakeTimers();
    rerender(<ToolSettingsCard descriptor={withTimezone('Europe/Lisbon')} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(screen.getByDisplayValue('Europe/Lisbon')).toBeInTheDocument();
    // Reading the remote value as a local edit would autosave it straight back,
    // which the tab that made the change then sees as a remote change of its
    // own: the two would trade writes for as long as both stay open.
    expect(countToolWrites()).toBe(0);
  });

  it('keeps a local edit when the descriptor changes underneath it', async () => {
    fetchScenario.respondWithJson('PUT', TOOL_PATH, {
      body: withTimezone('America/Sao_Paulo'),
    });

    const { rerender } = render(<ToolSettingsCard descriptor={DESCRIPTOR} />);

    vi.useFakeTimers();
    fireEvent.change(screen.getByDisplayValue('UTC'), {
      target: { value: 'America/Sao_Paulo' },
    });
    rerender(<ToolSettingsCard descriptor={withTimezone('Europe/Lisbon')} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    // The user is mid-edit on this control, so the remote value must not take
    // it — last writer wins, and the last writer here is the one still typing.
    expect(screen.getByDisplayValue('America/Sao_Paulo')).toBeInTheDocument();
    expect(countToolWrites()).toBe(1);
  });

  it('adopts a remote enablement change', async () => {
    const { rerender } = render(<ToolSettingsCard descriptor={DESCRIPTOR} />);

    expect(screen.getByRole('checkbox')).toBeChecked();

    vi.useFakeTimers();
    rerender(<ToolSettingsCard descriptor={{ ...DESCRIPTOR, enabled: false }} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(countToolWrites()).toBe(0);
  });
});
