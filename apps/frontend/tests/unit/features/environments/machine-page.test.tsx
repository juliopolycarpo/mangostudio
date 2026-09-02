/**
 * The machine page reads three independent queries and offers two actions.
 * What it must never do is hide the way forward: a refused action shows the
 * command to type, and an accepted one says the server is going away.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import type {
  MachineDoctorReport,
  MachineLogTail,
  MachineStatus,
} from '@mangostudio/shared/machine';
import userEvent from '@testing-library/user-event';
import { MachinePage } from '../../../../src/features/environments/machine/components/MachinePage';
import { render, screen, waitFor, within } from '../../../support/harness/render';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';

const STATUS: MachineStatus = {
  hub: {
    running: true,
    pid: 42,
    port: 3001,
    host: '127.0.0.1',
    url: 'http://127.0.0.1:3001',
    startedAt: 1_000,
    uptimeMs: 65_000,
    logFile: '/home/j/.mango/logs/server-1.log',
    version: '0.1.1',
    buildSha: 'abc1234def',
    health: 'ok',
    launch: 'detached',
  },
  service: {
    schemaVersion: 1,
    platform: 'linux',
    unitName: 'mangostudio.service',
    installed: false,
    enabled: false,
    running: false,
  },
  runtimeBinary: {
    path: '/home/j/.mango/dist/current/mangostudio-runtime',
    present: true,
    version: '0.1.1',
    versionMatches: true,
    error: null,
  },
  hostSlot: {
    present: false,
    profile: 'full',
    directory: '/home/j/.mango/runtime/host',
    error: null,
  },
  platform: 'linux',
  standalone: true,
  container: false,
  homeDir: '/home/j/.mango',
  logsDir: '/home/j/.mango/logs',
  configFile: '/home/j/.mango/config.toml',
  actions: {
    guard: { allowed: true, reasons: [] },
    restart: { available: true, command: 'mangostudio restart' },
    installService: { available: true, command: 'mangostudio service install' },
    uninstallService: {
      available: false,
      command: 'mangostudio service uninstall',
      reason: 'not-installed',
    },
  },
};

const DOCTOR: MachineDoctorReport = {
  checks: [
    { label: 'Config', status: 'ok', detail: '127.0.0.1:3001' },
    { label: 'Runtime binary', status: 'warn', detail: 'version drift' },
  ],
  warnings: 1,
  failures: 0,
};

const LOGS: MachineLogTail = {
  file: '/home/j/.mango/logs/server-1.log',
  lines: ['[api] MangoStudio API running on http://localhost:3001'],
  truncated: false,
};

const scenario = createFetchScenario();

function mountScenario(status: MachineStatus = STATUS) {
  scenario
    .respondWithJson('GET', '/api/machine/status', { body: status })
    .respondWithJson('GET', '/api/machine/doctor', { body: DOCTOR })
    .respondWithJson('GET', '/api/machine/logs?tail=200', { body: LOGS })
    .install();
}

afterEach(() => {
  scenario.restore();
});

describe('MachinePage', () => {
  it('renders the hub, service, doctor and log cards from the API', async () => {
    mountScenario();
    render(<MachinePage />);

    const hub = await screen.findByTestId('machine-hub-card');
    expect(within(hub).getByText('Running')).toBeTruthy();
    expect(within(hub).getByText('http://127.0.0.1:3001')).toBeTruthy();
    expect(within(hub).getByText('in the background')).toBeTruthy();
    expect(within(hub).getByTestId('machine-hub-health').textContent).toBe('Healthy');

    const service = screen.getByTestId('machine-service-card');
    expect(within(service).getByText('Not installed')).toBeTruthy();
    expect(within(service).getByTestId('machine-service-install')).toBeTruthy();

    await waitFor(() =>
      expect(screen.getByTestId('machine-doctor-summary').textContent).toBe(
        '1 warnings, 0 failures'
      )
    );
    expect(screen.getByText('Runtime binary', { selector: 'span' })).toBeTruthy();

    const logs = screen.getByTestId('machine-logs');
    await waitFor(() => expect(within(logs).getByText(/MangoStudio API running/)).toBeTruthy());
  });

  it('shows the copyable command and the guard sentence when the API refuses', async () => {
    mountScenario({
      ...STATUS,
      actions: {
        guard: { allowed: false, reasons: ['client-not-loopback'] },
        restart: { available: false, command: 'mangostudio restart', reason: 'guard' },
        installService: {
          available: false,
          command: 'mangostudio service install',
          reason: 'guard',
        },
        uninstallService: {
          available: false,
          command: 'mangostudio service uninstall',
          reason: 'guard',
        },
      },
    });
    render(<MachinePage />);

    const refused = await screen.findByTestId('machine-restart-refused');
    expect(refused.textContent).toContain('was not opened from the machine the hub runs on');
    expect(within(refused).getByText('mangostudio restart')).toBeTruthy();
    expect(screen.queryByTestId('machine-restart')).toBeNull();
  });

  it('explains a refused log tail instead of showing an error', async () => {
    scenario
      .respondWithJson('GET', '/api/machine/status', { body: STATUS })
      .respondWithJson('GET', '/api/machine/doctor', { body: DOCTOR })
      .respondWithJson('GET', '/api/machine/logs?tail=200', {
        status: 403,
        body: {
          error: 'not local',
          code: 'PERMISSION_DENIED',
          details: { reasons: 'client-not-loopback' },
        },
      })
      .install();
    render(<MachinePage />);
    const refused = await screen.findByTestId('machine-logs-refused');
    expect(refused.textContent).toContain('was not opened from the machine the hub runs on');
    expect(refused.textContent).toContain('mangostudio logs');
  });

  it('confirms a restart, posts it, and announces the hand-over', async () => {
    mountScenario();
    scenario.respondWithJson('POST', '/api/machine/restart', {
      status: 202,
      body: { accepted: true, message: 'Restarting in the background.' },
    });
    render(<MachinePage />);
    const user = userEvent.setup();

    await user.click(await screen.findByTestId('machine-restart'));
    const dialog = screen.getByRole('dialog', { name: 'Restart MangoStudio?' });
    expect(dialog.textContent).toContain('mangostudio restart');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));

    await waitFor(() =>
      expect(screen.getByTestId('machine-notice').textContent).toContain(
        'Restarting in the background.'
      )
    );
    const posts = scenario.fetchMock.mock.calls.filter(
      ([, init]) => init?.method?.toUpperCase() === 'POST'
    );
    expect(posts).toHaveLength(1);
  });
});
