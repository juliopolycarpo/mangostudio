/**
 * What the removal panel says happened.
 *
 * An apply stops at its first failure, so a run can end with copies that were
 * never reached and copies that were put back. Both were shown to the user as
 * scheduled for removal, and a panel that lists neither reads as though they
 * are gone.
 */

import { en } from '@mangostudio/shared/i18n';
import type { RemovalApply } from '@mangostudio/shared/library';
import { describe, expect, it } from 'vitest';
import { RemovalResultPanel } from '../../../../src/features/library/components/RemovalResultPanel';
import { render, screen } from '../../../support/harness/render';

function panelOf(result: RemovalApply) {
  return render(
    <RemovalResultPanel
      environmentName={(id: string) => id}
      result={result}
      undoResult={undefined}
      isUndoing={false}
      undoError={null}
      onUndo={() => undefined}
    />
  );
}

const stoppedShort: RemovalApply = {
  partial: false,
  backups: [],
  removed: [],
  kept: [
    {
      resourceKey: 'skill:gh',
      environmentId: 'local',
      locationId: 'agents-skills',
      reason: 'rolled-back',
    },
    {
      resourceKey: 'skill:gh',
      environmentId: 'local',
      locationId: 'mango-skills',
      reason: 'not-attempted',
    },
    {
      resourceKey: 'skill:gh',
      environmentId: 'local',
      locationId: 'codex-skills',
      reason: 'user-kept',
    },
  ],
  failed: [
    {
      resourceKey: 'skill:gh',
      environmentId: 'local',
      locationId: 'claude-skills',
      reason: 'remove-failed',
      message: 'disk went away',
    },
  ],
};

describe('RemovalResultPanel', () => {
  it('accounts for the copies the run never reached or put back', () => {
    panelOf(stoppedShort);

    const rows = screen.getAllByTestId('kept-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent(en.library.removalKeptReason['rolled-back']);
    expect(rows[1]).toHaveTextContent(en.library.removalKeptReason['not-attempted']);
  });

  it('stays quiet about the copies the user chose to keep', () => {
    panelOf(stoppedShort);

    // The user unchecked this one. Repeating it back as an outcome would bury
    // the two rows that are actually news.
    expect(screen.queryByText(en.library.removalKeptReason['user-kept'])).not.toBeInTheDocument();
  });

  it('says nothing was removed rather than nothing was written', () => {
    panelOf({ partial: false, backups: [], removed: [], kept: [], failed: [] });

    expect(screen.getByText(en.library.removal.resultNone)).toBeInTheDocument();
    expect(screen.queryByText(en.library.result.none)).not.toBeInTheDocument();
  });
});
