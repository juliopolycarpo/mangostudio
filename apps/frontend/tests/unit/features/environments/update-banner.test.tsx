/**
 * The update banner is mounted once above every page, so it must stay silent
 * far more often than it speaks: no update, no answer yet, or a version the
 * reader already dismissed.
 */

import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { MachineUpdateStatus } from '@mangostudio/shared/updates';
import { routerWithLinkStub } from '../../../support/mocks/router';

mock.module('@tanstack/react-router', await routerWithLinkStub());

const { UpdateBanner } = await import(
  '../../../../src/features/environments/machine/components/UpdateBanner'
);
const { render, screen, waitFor, within } = await import('../../../support/harness/render');
const { createFetchScenario } = await import('../../../support/mocks/create-fetch-scenario');

const UPDATE_DISMISSED_KEY = 'mangostudio:update-dismissed';
const LOCALE_STORAGE_KEY = 'mangostudio:locale';

const BASE_CHECK = {
  channel: 'stable' as const,
  currentVersion: '0.2.0',
  latestVersion: '0.3.0',
  updateAvailable: true,
  checkedAt: 1_700_000_000_000,
};

const SELF_MANAGED_STATUS: MachineUpdateStatus = {
  installedVia: {
    manager: 'self-managed',
    channel: 'stable',
    executable: '/home/j/.mango/dist/current/mangostudio',
  },
  channel: 'stable',
  check: BASE_CHECK,
  checksEnabled: true,
  canUpgrade: true,
};

const DELEGATE_STATUS: MachineUpdateStatus = {
  installedVia: {
    manager: 'npm',
    channel: 'stable',
    executable: '/usr/local/bin/mangostudio',
  },
  channel: 'stable',
  check: BASE_CHECK,
  checksEnabled: true,
  canUpgrade: false,
  reason: 'package-manager',
  command: 'npm update -g mangostudio',
};

const NO_UPDATE_STATUS: MachineUpdateStatus = {
  ...SELF_MANAGED_STATUS,
  check: { ...BASE_CHECK, updateAvailable: false, latestVersion: undefined },
};

const scenario = createFetchScenario();

function mountScenario(status: MachineUpdateStatus) {
  scenario.respondWithJson('GET', '/api/machine/update', { body: status }).install();
}

afterEach(() => {
  scenario.restore();
  window.localStorage.removeItem(UPDATE_DISMISSED_KEY);
  localStorage.removeItem(LOCALE_STORAGE_KEY);
});

describe('UpdateBanner', () => {
  it('offers an Upgrade button for a self-managed install', async () => {
    mountScenario(SELF_MANAGED_STATUS);
    render(<UpdateBanner />);

    const banner = await screen.findByTestId('machine-update-banner');
    expect(banner.textContent).toContain('0.3.0');
    expect(banner.textContent).toContain('0.2.0');
    expect(screen.getByTestId('machine-update-banner-action')).toBeTruthy();
  });

  it('offers the copyable command for a delegate install', async () => {
    mountScenario(DELEGATE_STATUS);
    render(<UpdateBanner />);

    const banner = await screen.findByTestId('machine-update-banner');
    expect(screen.queryByTestId('machine-update-banner-action')).toBeNull();
    expect(within(banner).getByText('npm update -g mangostudio')).toBeTruthy();
  });

  it('renders nothing when no update is available', async () => {
    mountScenario(NO_UPDATE_STATUS);
    render(<UpdateBanner />);

    await waitFor(() => expect(scenario.fetchMock).toHaveBeenCalled());
    expect(screen.queryByTestId('machine-update-banner')).toBeNull();
  });

  it('renders nothing once the exact latest version was dismissed', async () => {
    window.localStorage.setItem(UPDATE_DISMISSED_KEY, '0.3.0');
    mountScenario(SELF_MANAGED_STATUS);
    render(<UpdateBanner />);

    await waitFor(() => expect(scenario.fetchMock).toHaveBeenCalled());
    expect(screen.queryByTestId('machine-update-banner')).toBeNull();
  });

  it('renders again when the dismissed version is older than the fetched latest', async () => {
    window.localStorage.setItem(UPDATE_DISMISSED_KEY, '0.1.0');
    mountScenario(SELF_MANAGED_STATUS);
    render(<UpdateBanner />);

    expect(await screen.findByTestId('machine-update-banner')).toBeTruthy();
  });

  it('dismissing hides the banner and stores the dismissed version', async () => {
    mountScenario(SELF_MANAGED_STATUS);
    const { default: userEvent } = await import('@testing-library/user-event');
    render(<UpdateBanner />);

    await screen.findByTestId('machine-update-banner');
    const user = userEvent.setup();
    await user.click(screen.getByTestId('machine-update-banner-dismiss'));

    expect(screen.queryByTestId('machine-update-banner')).toBeNull();
    expect(window.localStorage.getItem(UPDATE_DISMISSED_KEY)).toBe('0.3.0');
  });

  it("renders the banner sentence in the reader's locale", async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'pt-BR');
    mountScenario(SELF_MANAGED_STATUS);
    render(<UpdateBanner />);

    const banner = await screen.findByTestId('machine-update-banner');
    expect(banner.textContent).toContain('O MangoStudio 0.3.0 está disponível');
    // "na versão {current}", not the missing-noun "na {current}".
    expect(banner.textContent).toContain('você está na versão 0.2.0');
    expect(within(banner).getByText('Atualizar')).toBeTruthy();
  });
});
