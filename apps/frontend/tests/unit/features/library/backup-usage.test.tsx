/**
 * The retained-backup list as the only surviving handle on a removal.
 *
 * The wizard's undo button dies with the wizard, so this list is where a user
 * who closed it — or reopened the app the next day — comes back for the skill
 * they deleted. Offering only a purge there means the app kept the copy and
 * never handed it back.
 */

import { en } from '@mangostudio/shared/i18n';
import type { PropagationBackupUsage, PropagationUndo } from '@mangostudio/shared/library';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { BackupUsage } from '../../../../src/features/library/components/BackupUsage';
import { render, screen, waitFor } from '../../../support/harness/render';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';

const BACKUP_ID = '2026-07-28T10-00-00.000Z-abc123';

const usage: PropagationBackupUsage = {
  setCount: 1,
  sizeBytes: 4096,
  retentionCount: 5,
  retentionBytes: 100_000_000,
  pinnedSizeBytes: 4096,
  sets: [
    {
      backupId: BACKUP_ID,
      createdAtMs: 1_785_000_000_000,
      sizeBytes: 4096,
      entryCount: 1,
      pinned: true,
      lastCopyResourceKeys: ['skill:gh'],
    },
  ],
};

const undone: PropagationUndo = {
  backupId: BACKUP_ID,
  restored: [{ locationId: 'claude-skills', destinationPath: '~/.claude/skills/gh' }],
  removed: [],
  skipped: [],
};

const scenario = createFetchScenario();

afterEach(() => {
  scenario.restore();
});

async function renderUsage(undoResponse: { body?: unknown; status?: number } = { body: undone }) {
  scenario
    .respondWithJson('GET', '/api/library/propagate/backups', { body: usage })
    .respondWithJson('POST', '/api/library/propagate/undo', undoResponse)
    .install();

  render(<BackupUsage />);
  await screen.findByTestId('pinned-backup-row');
}

describe('BackupUsage', () => {
  it('puts a retained backup back on disk', async () => {
    await renderUsage();

    await userEvent.click(screen.getByTestId('restore-backup'));

    await waitFor(() => {
      expect(screen.getByTestId('restore-backup-result')).toHaveTextContent(
        en.library.backups.restored.replace('{count}', '1')
      );
    });
    const undoCalls = scenario.fetchMock.mock.calls.filter(([input]) =>
      String(input).includes('/library/propagate/undo')
    );
    expect(undoCalls).toHaveLength(1);
  });

  it('names the copies a restore refused to touch', async () => {
    await renderUsage({
      body: {
        ...undone,
        restored: [],
        skipped: [
          {
            locationId: 'claude-skills',
            destinationPath: '~/.claude/skills/gh',
            reason: 'changed-since-apply',
          },
        ],
      } satisfies PropagationUndo,
    });

    await userEvent.click(screen.getByTestId('restore-backup'));

    // "0 put back" alone reads like a success; the count and the reason
    // together are what tell the user the destination moved under them.
    await waitFor(() => {
      expect(screen.getByTestId('restore-backup-result')).toHaveTextContent(
        en.library.result.undoSkipped.replace('{count}', '1')
      );
    });
  });

  it('reports a failed restore instead of leaving the row unchanged', async () => {
    await renderUsage({ body: { error: 'nope', code: 'INTERNAL' }, status: 500 });

    await userEvent.click(screen.getByTestId('restore-backup'));

    await waitFor(() => {
      expect(screen.getByTestId('restore-backup-error')).toHaveTextContent(
        en.library.backups.restoreError
      );
    });
    expect(screen.queryByTestId('restore-backup-result')).not.toBeInTheDocument();
  });
});
