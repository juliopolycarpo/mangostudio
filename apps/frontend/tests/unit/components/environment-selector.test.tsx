/**
 * The environment pill on its own. It used to be exercised through `InputBar`;
 * now that it renders in the header instead of the composer, the flow is pinned
 * here, against the component both hosts share.
 */

import { describe, expect, it, jest } from 'bun:test';
import type { Environment } from '@mangostudio/shared/environments';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EnvironmentSelector } from '../../../src/features/environments/components/EnvironmentSelector';
import { render } from '../../support/harness/render';
import { createFetchScenario } from '../../support/mocks/create-fetch-scenario';

const ENVIRONMENTS: Environment[] = [
  {
    id: 'local',
    name: 'Local',
    transportKind: 'in-process',
    config: {},
    enabled: true,
    allowInstalls: false,
    virtual: true,
    createdAt: null,
    updatedAt: null,
    status: { state: 'connected' },
  },
  {
    id: 'remote-dev',
    name: 'Remote dev',
    transportKind: 'ssh',
    config: { host: 'dev.example.test' },
    enabled: true,
    allowInstalls: false,
    virtual: false,
    createdAt: 1,
    updatedAt: 1,
    status: { state: 'disconnected' },
  },
];

describe('EnvironmentSelector', () => {
  it('names the current environment and changes it from the pill', async () => {
    const scenario = createFetchScenario();
    scenario.respondWithJson('GET', '/api/environments', { body: ENVIRONMENTS }).install();

    try {
      const user = userEvent.setup();
      const onEnvironmentChange = jest.fn().mockResolvedValue(undefined);
      render(
        <EnvironmentSelector environmentId="local" onEnvironmentChange={onEnvironmentChange} />
      );

      const selector = await screen.findByRole('combobox', {
        name: 'Select execution environment',
      });
      // The pill renders before the listing lands, wearing the `disconnected`
      // fallback and the bare id for a name, so the connected state is only
      // meaningful once the fetched environment backs it.
      await waitFor(() =>
        expect(screen.getByTestId('environment-selector')).toHaveAttribute(
          'data-state',
          'connected'
        )
      );
      expect(selector).toHaveTextContent('Local');
      expect(selector).toHaveAccessibleDescription('Connected');
      await user.click(selector);
      await user.click(await screen.findByRole('option', { name: 'Remote dev' }));

      expect(onEnvironmentChange).toHaveBeenCalledWith('remote-dev');
    } finally {
      scenario.restore();
    }
  });

  it('opens its listbox below the chip, because the chip sits at the top of the page', async () => {
    const scenario = createFetchScenario();
    scenario.respondWithJson('GET', '/api/environments', { body: ENVIRONMENTS }).install();

    try {
      const user = userEvent.setup();
      render(<EnvironmentSelector environmentId="local" onEnvironmentChange={jest.fn()} />);

      await user.click(
        await screen.findByRole('combobox', { name: 'Select execution environment' })
      );

      // Anchored under the trigger. The upward default put the panel above the
      // viewport, clipped away, so no environment could ever be chosen.
      const panel = (await screen.findByRole('listbox')).parentElement as HTMLElement;
      expect(panel.className).toContain('top-full');
      expect(panel.className).not.toContain('bottom-full');
    } finally {
      scenario.restore();
    }
  });

  it('states a locked environment as a fact instead of a faded control', async () => {
    const scenario = createFetchScenario();
    scenario.respondWithJson('GET', '/api/environments', { body: ENVIRONMENTS }).install();

    try {
      const onEnvironmentChange = jest.fn();
      render(
        <EnvironmentSelector
          environmentId="local"
          locked
          onEnvironmentChange={onEnvironmentChange}
        />
      );

      const chip = screen.getByTestId('environment-selector');
      await waitFor(() => expect(chip).toHaveAttribute('data-state', 'connected'));
      // Nothing to open, and nothing that looks like it could be.
      expect(screen.queryByRole('combobox')).toBeNull();
      expect(chip).toHaveTextContent('env:Local');
      // The reason follows the chip as text, and the connection state still describes it.
      expect(chip).toHaveTextContent('Locked once the first turn starts');
      const described = chip.querySelector('[aria-describedby]');
      expect(described).not.toBeNull();
      expect(described).toHaveAccessibleDescription('Connected');
      // Full-strength text: the 50% fade is for a control that is off, not for a fact.
      expect(chip.querySelector('[class*="opacity-50"]')).toBeNull();
    } finally {
      scenario.restore();
    }
  });

  it('refuses to open while disabled', async () => {
    const scenario = createFetchScenario();
    scenario.respondWithJson('GET', '/api/environments', { body: ENVIRONMENTS }).install();

    try {
      const onEnvironmentChange = jest.fn();
      render(
        <EnvironmentSelector
          environmentId="local"
          disabled
          onEnvironmentChange={onEnvironmentChange}
        />
      );

      const selector = await screen.findByRole('combobox', {
        name: 'Select execution environment',
      });
      expect(selector).toBeDisabled();
    } finally {
      scenario.restore();
    }
  });
});
