/**
 * The dialog's terminal states. An `upgraded` outcome is not the end of the
 * story: the engine reports whether the new version is actually serving, and
 * a foreground hub or a Windows Scheduled Task comes back as `restart:
 * 'manual'` with the old process still running.
 */

import { afterEach, describe, expect, it, mock } from 'bun:test';
import type {
  MachineUpdateStatus,
  UpgradeReport,
  UpgradeRestart,
} from '@mangostudio/shared/updates';
import type { UseUpgradeStreamResult } from '../../../../src/features/environments/machine/hooks/use-upgrade-stream';

/** One canned terminal stream, swapped per case before the dialog mounts. */
let streamResult: UseUpgradeStreamResult;

mock.module('../../../../src/features/environments/machine/hooks/use-upgrade-stream', () => ({
  UPGRADE_CONSOLE_MAX_LINES: 2000,
  useUpgradeStream: () => streamResult,
}));

const { UpgradeDialog } = await import(
  '../../../../src/features/environments/machine/components/UpgradeDialog'
);
const { fireEvent, render, screen } = await import('../../../support/harness/render');

const STATUS: MachineUpdateStatus = {
  installedVia: {
    manager: 'self-managed',
    channel: 'stable',
    executable: '/home/j/.mango/dist/current/mangostudio',
  },
  channel: 'stable',
  check: {
    channel: 'stable',
    currentVersion: '0.2.0',
    latestVersion: '0.3.0',
    updateAvailable: true,
    checkedAt: 1_700_000_000_000,
  },
  checksEnabled: true,
  canUpgrade: true,
};

function upgradedReport(restart?: UpgradeRestart): UpgradeReport {
  return {
    outcome: 'upgraded',
    installedVia: STATUS.installedVia,
    currentVersion: '0.2.0',
    target: {
      channel: 'stable',
      version: '0.3.0',
      assetName: 'mangostudio-0.3.0-linux-x64.tar.gz',
      url: 'https://example.test/a.tar.gz',
      kind: 'archive',
      verification: 'sha256-sums',
    },
    ...(restart ? { restart } : {}),
    exitCode: 0,
  };
}

function doneWith(report: UpgradeReport): UseUpgradeStreamResult {
  return {
    phase: 'done',
    stages: [],
    lines: [],
    report,
    refusal: null,
    streamError: null,
    start: () => undefined,
    reset: () => undefined,
  };
}

/** Mount and click through the confirm step, which is all the dialog shows first. */
function openOutcome(): void {
  render(<UpgradeDialog status={STATUS} onClose={() => undefined} />);
  fireEvent.click(screen.getByRole('button', { name: /upgrade/i }));
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('UpgradeDialog terminal outcome', () => {
  it('says the server is restarting when the engine scheduled one', () => {
    streamResult = doneWith(upgradedReport('scheduled'));

    openOutcome();

    expect(screen.getByText(/Upgraded to 0\.3\.0/)).toBeInTheDocument();
    expect(screen.getByTestId('upgrade-restart-note')).toHaveTextContent(/restarting/i);
  });

  for (const restart of ['manual', 'skipped'] as const) {
    it(`warns that the old version is still serving on restart: '${restart}'`, () => {
      // Without this the dialog showed only "Upgraded to 0.3.0." — an install
      // that still needs a hand-run restart read as finished.
      streamResult = doneWith(upgradedReport(restart));

      openOutcome();

      expect(screen.getByText(/Upgraded to 0\.3\.0/)).toBeInTheDocument();
      expect(screen.getByTestId('upgrade-restart-note')).toHaveTextContent(
        /still running the old/i
      );
    });
  }

  it('says when the new version starts with the next run, nothing being live', () => {
    streamResult = doneWith(upgradedReport('not-running'));

    openOutcome();

    expect(screen.getByTestId('upgrade-restart-note')).toHaveTextContent(/next time/i);
  });

  it('adds no restart line when the report names no restart', () => {
    streamResult = doneWith(upgradedReport());

    openOutcome();

    expect(screen.getByText(/Upgraded to 0\.3\.0/)).toBeInTheDocument();
    expect(screen.queryByTestId('upgrade-restart-note')).toBeNull();
  });
});
