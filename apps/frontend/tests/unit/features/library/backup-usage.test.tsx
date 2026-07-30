/**
 * The disclosure strip under the library, reduced to what it can carry.
 *
 * It states the cost and the retention rule, and hands off to the manager for
 * anything set-shaped. What it must never do is disappear: the strip is the
 * only signal on the library page that the app is holding copies at all, and
 * the only way a user finds the screen that hands them back.
 */

import { en } from '@mangostudio/shared/i18n';
import type { PropagationBackupUsage } from '@mangostudio/shared/library';
import { afterEach, describe, expect, it } from 'vitest';
import { BackupUsage } from '../../../../src/features/library/components/BackupUsage';
import { screen } from '../../../support/harness/render';
import { renderWithRouter } from '../../../support/harness/render-with-router';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';

const usage: PropagationBackupUsage = {
  setCount: 3,
  sizeBytes: 4096,
  retentionCount: 5,
  retentionBytes: 100_000_000,
  pinnedSizeBytes: 4096,
  sets: [
    {
      backupId: '2026-07-28T10-00-00.000Z-abc123',
      createdAtMs: 1_785_000_000_000,
      sizeBytes: 4096,
      entryCount: 1,
      pinned: true,
      lastCopyResourceKeys: ['skill:gh'],
      operation: 'removal',
      resourceKeys: ['skill:gh'],
      evictsNext: false,
    },
  ],
};

const scenario = createFetchScenario();

afterEach(() => {
  scenario.restore();
});

async function renderUsage(body: PropagationBackupUsage | { setCount: number } = usage) {
  scenario.respondWithJson('GET', '/api/library/propagate/backups', { body }).install();
  await renderWithRouter(<BackupUsage />);
}

describe('BackupUsage', () => {
  it('states what backups cost and the rule that trims them', async () => {
    await renderUsage();

    const strip = await screen.findByTestId('backup-usage');
    expect(strip).toHaveTextContent(
      en.library.backups.usage.replace('{count}', '3').replace('{size}', '4.0 KiB')
    );
    expect(strip).toHaveTextContent(
      en.library.backups.retention.replace('{count}', '5').replace('{size}', '95.4 MiB')
    );
  });

  // The sets themselves moved to a screen with room for them, so this link is
  // the only route to a removal a user wants back the next day.
  it('links to the manager where the sets can be restored', async () => {
    await renderUsage();

    const link = await screen.findByTestId('manage-backups');
    expect(link).toHaveTextContent(en.library.backups.manage);
    expect(link).toHaveAttribute('href', '/environments/library/backups');
  });

  it('discloses nothing when nothing is retained', async () => {
    await renderUsage({
      ...usage,
      setCount: 0,
      sizeBytes: 0,
      pinnedSizeBytes: 0,
      sets: [],
    });

    expect(screen.queryByTestId('backup-usage')).not.toBeInTheDocument();
  });
});
