/**
 * The always-on step must not call a supervisor it could not ask "Not installed".
 *
 * An unreadable service manager (no user session bus, no systemd) reaches this
 * page as `installed: false` plus an `error`. The step used to draw that as a
 * definite neutral "Not installed" and then point at "the error above" — which
 * was never rendered. The error is the headline of that state, and "Not
 * installed" belongs only to a supervisor that answered.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { en } from '@mangostudio/shared/i18n';
import { screen, waitFor } from '@testing-library/react';
import { ServiceStep } from '@/features/onboarding/steps/ServiceStep';
import { render } from '../../../support/harness/render';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';

const scenario = createFetchScenario();

const SESSION_BUS_ERROR = 'Failed to connect to bus: No medium found';

type ServiceOverrides = Record<string, unknown>;
type InstallOverrides = Record<string, unknown>;

function machineStatus(service: ServiceOverrides, installService: InstallOverrides) {
  return {
    hub: { running: true, pid: 1, host: '127.0.0.1', port: 3001, launch: 'foreground' },
    service: {
      installed: false,
      enabled: false,
      running: false,
      platform: 'linux',
      unitName: 'mangostudio',
      ...service,
    },
    runtimeBinary: { kind: 'binary', path: '/usr/bin/mangostudio', version: '0.1.1' },
    hostSlot: { present: false, profile: 'full', directory: '', error: null },
    platform: 'linux',
    standalone: true,
    container: false,
    homeDir: '/home/dev/.mango',
    logsDir: '/home/dev/.mango/logs',
    configFile: null,
    actions: {
      guard: { allowed: true, reasons: [] },
      restart: { available: true, command: 'mangostudio restart' },
      installService: { command: 'mangostudio service install', ...installService },
      uninstallService: { available: false, command: 'mangostudio service uninstall' },
    },
  };
}

function respondWith(service: ServiceOverrides, installService: InstallOverrides) {
  scenario.respondWithJson('GET', '/api/machine/status', {
    body: machineStatus(service, installService),
  });
  scenario.install();
}

beforeEach(() => scenario.restore());
afterEach(() => scenario.restore());

describe('ServiceStep', () => {
  it('says the supervisor could not be asked, with its error, instead of "Not installed"', async () => {
    respondWith(
      { error: SESSION_BUS_ERROR, errorCode: 'no-session-bus' },
      { available: false, reason: 'service-unreadable' }
    );
    render(<ServiceStep />);

    const state = await screen.findByTestId('onboarding-service-state');
    expect(state).toHaveClass('bg-warning-subtle');
    expect(state).toHaveTextContent(en.environments.machine.service.errors['no-session-bus']);
    expect(state).toHaveTextContent(SESSION_BUS_ERROR);
    expect(screen.queryByText(en.onboarding.service.notInstalled)).not.toBeInTheDocument();
    // "See the error above" is the machine page's sentence; this step's own
    // warning is the error, so repeating it would point at itself.
    expect(
      screen.queryByText(en.environments.machine.actions.reasons['service-unreadable'])
    ).not.toBeInTheDocument();
    // The command to run on the hub's own computer is still on offer.
    expect(screen.getByTestId('onboarding-service-refused')).toHaveTextContent(
      'mangostudio service install'
    );
  });

  it('titles an uncoded supervisor error with the step’s own sentence and keeps the raw line', async () => {
    respondWith(
      { error: 'launchctl: Could not find domain for user' },
      { available: false, reason: 'service-unreadable' }
    );
    render(<ServiceStep />);

    const state = await screen.findByTestId('onboarding-service-state');
    expect(state).toHaveTextContent(en.onboarding.service.unreadable);
    expect(state).toHaveTextContent('launchctl: Could not find domain for user');
    expect(state).not.toHaveTextContent(en.onboarding.service.notInstalled);
  });

  it('does not call a service "Not installed" when the guard refused before the supervisor was read', async () => {
    respondWith(
      { error: SESSION_BUS_ERROR, errorCode: 'no-session-bus' },
      { available: false, reason: 'guard' }
    );
    render(<ServiceStep />);

    const state = await screen.findByTestId('onboarding-service-state');
    expect(state).toHaveClass('bg-warning-subtle');
    expect(screen.queryByText(en.onboarding.service.notInstalled)).not.toBeInTheDocument();
    // The guard is a different fact from the unreadable supervisor, and it keeps its sentence.
    expect(screen.getByText(en.environments.machine.actions.reasons.guard)).toBeInTheDocument();
  });

  it('keeps a plain "Not installed" for a supervisor that answered', async () => {
    respondWith({}, { available: true });
    render(<ServiceStep />);

    const state = await screen.findByTestId('onboarding-service-state');
    expect(state).toHaveTextContent(en.onboarding.service.notInstalled);
    expect(state).toHaveClass('bg-fill-selected');
    expect(state).not.toHaveClass('bg-warning-subtle');
    await waitFor(() =>
      expect(screen.getByTestId('onboarding-install-service')).toBeInTheDocument()
    );
  });
});
