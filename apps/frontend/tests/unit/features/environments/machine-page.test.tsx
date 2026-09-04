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
import type { MachineUpdateStatus } from '@mangostudio/shared/updates';
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

const UPDATE_STATUS: MachineUpdateStatus = {
  installedVia: {
    manager: 'self-managed',
    channel: 'stable',
    executable: '/home/j/.mango/dist/current/mangostudio',
  },
  check: {
    channel: 'stable',
    currentVersion: '0.1.1',
    latestVersion: '0.1.1',
    updateAvailable: false,
    checkedAt: 1_700_000_000_000,
  },
  checksEnabled: true,
  canUpgrade: true,
};

const scenario = createFetchScenario();

function mountScenario(
  status: MachineStatus = STATUS,
  update: MachineUpdateStatus = UPDATE_STATUS
) {
  scenario
    .respondWithJson('GET', '/api/machine/status', { body: status })
    .respondWithJson('GET', '/api/machine/doctor', { body: DOCTOR })
    .respondWithJson('GET', '/api/machine/logs?tail=200', { body: LOGS })
    .respondWithJson('GET', '/api/machine/update', { body: update })
    .install();
}

const LOCALE_STORAGE_KEY = 'mangostudio:locale';

afterEach(() => {
  scenario.restore();
  // Every other test in this file reads English; a leaked locale would make
  // them fail somewhere far from the test that set it.
  localStorage.removeItem(LOCALE_STORAGE_KEY);
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
      .respondWithJson('GET', '/api/machine/update', { body: UPDATE_STATUS })
      .install();
    render(<MachinePage />);
    const refused = await screen.findByTestId('machine-logs-refused');
    expect(refused.textContent).toContain('was not opened from the machine the hub runs on');
    expect(refused.textContent).toContain('mangostudio logs');
  });

  it("words an accepted action in the reader's locale, not the hub's", async () => {
    // The API answers with a code; the sentence is the page's to choose. A
    // response rendered verbatim would be English here.
    localStorage.setItem(LOCALE_STORAGE_KEY, 'pt-BR');
    mountScenario();
    scenario.respondWithJson('POST', '/api/machine/service', {
      status: 202,
      body: { accepted: true, outcome: 'service-installed-handover', unit: 'mangostudio.service' },
    });
    render(<MachinePage />);
    const user = userEvent.setup();

    await user.click(await screen.findByTestId('machine-service-install'));
    const dialog = screen.getByRole('dialog', { name: 'Instalar o serviço?' });
    await user.click(within(dialog).getByRole('button', { name: 'Continuar' }));

    await waitFor(() =>
      expect(screen.getByTestId('machine-notice').textContent).toContain(
        'mangostudio.service instalado. Entregando o lugar a ele agora'
      )
    );
  });

  it("words a refused action in the reader's locale too", async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'pt-BR');
    mountScenario();
    // The status said restart was available; by the time the POST lands the
    // hub is in a terminal, so the refusal arrives with the response.
    scenario.respondWithJson('POST', '/api/machine/restart', {
      status: 409,
      body: {
        error: 'The server was started in a terminal, which owns its lifecycle.',
        code: 'UNSUPPORTED',
        details: { reason: 'foreground', command: 'mangostudio restart' },
      },
    });
    render(<MachinePage />);
    const user = userEvent.setup();

    await user.click(await screen.findByTestId('machine-restart'));
    const dialog = screen.getByRole('dialog', { name: 'Reiniciar o MangoStudio?' });
    await user.click(within(dialog).getByRole('button', { name: 'Continuar' }));

    // The API's own sentence for this is English; the code is what travels.
    await waitFor(() =>
      expect(document.body.textContent).toContain('O servidor foi iniciado em um terminal')
    );
  });

  it('confirms a restart, posts it, and announces the hand-over', async () => {
    mountScenario();
    scenario.respondWithJson('POST', '/api/machine/restart', {
      status: 202,
      body: { accepted: true, outcome: 'restarting-detached' },
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

  it('shows what installed the hub and the release checker last answer', async () => {
    mountScenario();
    render(<MachinePage />);

    const card = await screen.findByTestId('machine-update-card');
    expect(within(card).getByText('Installed via')).toBeTruthy();
    expect(within(card).getByText('Install script')).toBeTruthy();
    expect(within(card).getByText('Up to date (0.1.1)')).toBeTruthy();
  });
});
