/**
 * The backup manager as the only surviving handle on an apply or a removal.
 *
 * The wizard's undo button dies with the wizard, so this list is where a user
 * who closed it — or reopened the app the next day — comes back for what they
 * lost. The assertions that matter most are the labels: undo restores content
 * for a removal set and deletes it for a propagation set that created paths, so
 * a row wearing the wrong verb is a delete button reading "put the copies back".
 */

import { en } from '@mangostudio/shared/i18n';
import type {
  PropagationBackupSet,
  PropagationBackupUsage,
  PropagationUndo,
} from '@mangostudio/shared/library';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { BackupList } from '../../../../src/features/library/components/BackupList';
import { render, screen, waitFor, within } from '../../../support/harness/render';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';

const REMOVAL_ID = '2026-07-28T10-00-00.000Z-abc123';
const PROPAGATION_ID = '2026-07-27T18-22-00.000Z-def456';
const LEGACY_ID = '2026-07-26T09-03-00.000Z-999999';

function set(overrides: Partial<PropagationBackupSet> = {}): PropagationBackupSet {
  return {
    backupId: REMOVAL_ID,
    createdAtMs: 1_785_000_000_000,
    sizeBytes: 4096,
    entryCount: 1,
    pinned: false,
    lastCopyResourceKeys: [],
    operation: 'removal',
    resourceKeys: ['skill:gh'],
    evictsNext: false,
    ...overrides,
  };
}

function usageOf(sets: PropagationBackupSet[]): PropagationBackupUsage {
  return {
    setCount: sets.length,
    sizeBytes: sets.reduce((total, item) => total + item.sizeBytes, 0),
    retentionCount: 5,
    retentionBytes: 100_000_000,
    pinnedSizeBytes: sets
      .filter((item) => item.pinned)
      .reduce((total, item) => total + item.sizeBytes, 0),
    sets,
  };
}

const undone: PropagationUndo = {
  backupId: REMOVAL_ID,
  restored: [{ locationId: 'claude-skills', destinationPath: '~/.claude/skills/gh' }],
  removed: [],
  skipped: [],
};

const scenario = createFetchScenario();

afterEach(() => {
  scenario.restore();
});

async function renderList(
  sets: PropagationBackupSet[] = [set()],
  responses: {
    undo?: { body?: unknown; status?: number };
    purge?: { body?: unknown; status?: number };
  } = {}
) {
  scenario
    .respondWithJson('GET', '/api/library/propagate/backups', { body: usageOf(sets) })
    .respondWithJson('POST', '/api/library/propagate/undo', responses.undo ?? { body: undone })
    .respondWithJson(
      'DELETE',
      `/api/library/propagate/backups/${REMOVAL_ID}`,
      responses.purge ?? { body: undefined, status: 204 }
    )
    .install();

  render(<BackupList />);
  if (sets.length > 0) await screen.findAllByTestId('backup-row');
  else await screen.findByTestId('backup-list-empty');
}

function rowFor(backupId: string): HTMLElement {
  const row = screen
    .getAllByTestId('backup-row')
    .find((candidate) => candidate.dataset.backupId === backupId);
  if (!row) throw new Error(`No row rendered for backup "${backupId}".`);
  return row;
}

describe('BackupList', () => {
  it('lists every retained set, not only the pinned ones', async () => {
    await renderList([
      set(),
      set({ backupId: PROPAGATION_ID, operation: 'propagation' }),
      set({ backupId: LEGACY_ID, operation: 'unknown', resourceKeys: [] }),
    ]);

    expect(screen.getAllByTestId('backup-row')).toHaveLength(3);
  });

  /*
    The mislabeling risk, asserted against the i18n keys. Undo branches on
    whether an entry recorded a backup, so it puts content back for a removal
    and takes content away for an apply that created the path. A single verb
    across both rows is the regression this whole feature would be.
  */
  it('labels undo by what wrote the set, never with one verb for both', async () => {
    await renderList([set(), set({ backupId: PROPAGATION_ID, operation: 'propagation' })]);

    expect(within(rowFor(REMOVAL_ID)).getByTestId('restore-backup')).toHaveTextContent(
      en.library.backups.undoRemoval
    );
    expect(within(rowFor(PROPAGATION_ID)).getByTestId('restore-backup')).toHaveTextContent(
      en.library.backups.undoPropagation
    );
  });

  // A manifest written before the origin was recorded gets the neutral verb and
  // says why. Guessing here is the unsound case: a propagation apply that only
  // overwrote files produces entries shaped exactly like a removal's.
  it('stays neutral on a set whose origin was never recorded', async () => {
    await renderList([set({ backupId: LEGACY_ID, operation: 'unknown', resourceKeys: [] })]);

    const row = rowFor(LEGACY_ID);
    expect(within(row).getByTestId('restore-backup')).toHaveTextContent(
      en.library.backups.undoUnknown
    );
    expect(within(row).getByTestId('backup-unknown-hint')).toHaveTextContent(
      en.library.backups.undoUnknownHint
    );
    expect(within(row).getByTestId('backup-origin')).toHaveTextContent(
      en.library.backups.origin.unknown
    );
  });

  it('names what a set holds, and falls back to a count when it cannot', async () => {
    await renderList([
      set({ resourceKeys: ['skill:gh', 'skill:release'] }),
      set({ backupId: LEGACY_ID, operation: 'unknown', resourceKeys: [], entryCount: 3 }),
    ]);

    expect(within(rowFor(REMOVAL_ID)).getByTestId('backup-contents')).toHaveTextContent(
      'skill:gh, skill:release'
    );
    expect(within(rowFor(LEGACY_ID)).getByTestId('backup-contents')).toHaveTextContent(
      en.library.backups.contentsUnknown.replace('{count}', '3')
    );
  });

  // Retention evicts on the next apply. Saying so afterwards is saying it too
  // late, which is the whole reason the flag is computed server-side.
  it('marks the set retention is about to take, before it goes', async () => {
    await renderList([
      set(),
      set({ backupId: PROPAGATION_ID, operation: 'propagation', evictsNext: true }),
    ]);

    expect(within(rowFor(PROPAGATION_ID)).getByTestId('backup-evicts-next')).toHaveTextContent(
      en.library.backups.evictsNext
    );
    expect(within(rowFor(REMOVAL_ID)).queryByTestId('backup-evicts-next')).not.toBeInTheDocument();
  });

  it('puts a retained backup back and reports what it touched', async () => {
    await renderList();

    await userEvent.click(within(rowFor(REMOVAL_ID)).getByTestId('restore-backup'));

    await waitFor(() => {
      expect(within(rowFor(REMOVAL_ID)).getByTestId('restore-backup-result')).toHaveTextContent(
        en.library.result.undone.replace('{restored}', '1').replace('{removed}', '0')
      );
    });
  });

  // "0 restored" alone reads like a success; the count and the reason together
  // are what tell the user the destination moved under them.
  it('names the copies a restore refused to touch', async () => {
    await renderList([set()], {
      undo: {
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
      },
    });

    await userEvent.click(within(rowFor(REMOVAL_ID)).getByTestId('restore-backup'));

    await waitFor(() => {
      expect(within(rowFor(REMOVAL_ID)).getByTestId('restore-backup-result')).toHaveTextContent(
        en.library.result.undoSkipped.replace('{count}', '1')
      );
    });
  });

  /*
    Reported against the row the manifest names, not the last row clicked. The
    undo response carries the id it acted on, and a result rendered on the wrong
    row tells a user their apply was undone when a different one was.
  */
  it('reports the restore against the set the response names', async () => {
    await renderList([set(), set({ backupId: PROPAGATION_ID, operation: 'propagation' })]);

    await userEvent.click(within(rowFor(PROPAGATION_ID)).getByTestId('restore-backup'));

    await waitFor(() => {
      expect(within(rowFor(REMOVAL_ID)).getByTestId('restore-backup-result')).toBeInTheDocument();
    });
    expect(
      within(rowFor(PROPAGATION_ID)).queryByTestId('restore-backup-result')
    ).not.toBeInTheDocument();
  });

  it('reports a failed restore instead of leaving the row unchanged', async () => {
    await renderList([set()], { undo: { body: { error: 'nope', code: 'INTERNAL' }, status: 500 } });

    await userEvent.click(within(rowFor(REMOVAL_ID)).getByTestId('restore-backup'));

    await waitFor(() => {
      expect(within(rowFor(REMOVAL_ID)).getByTestId('restore-backup-error')).toHaveTextContent(
        en.library.backups.restoreError
      );
    });
    expect(
      within(rowFor(REMOVAL_ID)).queryByTestId('restore-backup-result')
    ).not.toBeInTheDocument();
  });

  /*
    Every row, pinned or not. Ordinary sets became purgeable here for the first
    time, and one click destroying a recoverable copy — because nothing happened
    to pin it — is the asymmetry this screen must not inherit.
  */
  it('asks twice before deleting an unpinned set', async () => {
    await renderList([set({ pinned: false })]);

    const row = rowFor(REMOVAL_ID);
    await userEvent.click(within(row).getByTestId('purge-backup'));

    expect(within(row).getByTestId('purge-backup-confirm')).toBeInTheDocument();
    expect(
      scenario.fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')
    ).toHaveLength(0);

    await userEvent.click(within(row).getByTestId('purge-backup-confirm'));

    await waitFor(() => {
      expect(
        scenario.fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')
      ).toHaveLength(1);
    });
  });

  it('lets the confirm be backed out of without deleting anything', async () => {
    await renderList([set()]);

    const row = rowFor(REMOVAL_ID);
    await userEvent.click(within(row).getByTestId('purge-backup'));
    await userEvent.click(within(row).getByTestId('purge-backup-cancel'));

    expect(within(row).getByTestId('purge-backup')).toBeInTheDocument();
    expect(
      scenario.fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')
    ).toHaveLength(0);
  });

  // A failed purge that says nothing is indistinguishable from one that worked,
  // and the set is still on disk counting against the retention budget.
  it('reports a failed purge on the row it was asked for', async () => {
    await renderList([set()], {
      purge: { body: { error: 'nope', code: 'INTERNAL' }, status: 500 },
    });

    const row = rowFor(REMOVAL_ID);
    await userEvent.click(within(row).getByTestId('purge-backup'));
    await userEvent.click(within(row).getByTestId('purge-backup-confirm'));

    await waitFor(() => {
      expect(within(rowFor(REMOVAL_ID)).getByTestId('purge-backup-error')).toHaveTextContent(
        en.library.backups.purgeError
      );
    });
  });

  it('says so when nothing is being held', async () => {
    await renderList([]);

    expect(screen.getByTestId('backup-list-empty')).toHaveTextContent(en.library.backups.empty);
  });

  // Bulk actions are one misclick across every location the app writes into, so
  // their absence is a stated decision rather than an oversight.
  it('offers no bulk restore or bulk purge', async () => {
    await renderList([set(), set({ backupId: PROPAGATION_ID, operation: 'propagation' })]);

    expect(screen.getByTestId('backup-list')).toHaveTextContent(en.library.backups.bulkHint);
    expect(screen.getAllByTestId('purge-backup')).toHaveLength(2);
    expect(screen.getAllByTestId('restore-backup')).toHaveLength(2);
  });
});
