/**
 * The result panel and undo.
 *
 * Undo stays reachable because the realization usually arrives a minute after
 * the apply, and `partial: true` is the one case that has to shout: compensation
 * failed, so writes are still on disk.
 */

import { describe, expect, it, jest } from 'bun:test';
import { en } from '@mangostudio/shared/i18n';
import type { PropagationApply, PropagationUndo } from '@mangostudio/shared/library';
import userEvent from '@testing-library/user-event';
import { ResultPanel } from '../../../../src/features/library/components/ResultPanel';
import { render, screen } from '../../../support/harness/render';

const applied: PropagationApply = {
  backupId: 'backup-2026-07-27',
  backups: [{ environmentId: 'local', backupId: 'backup-2026-07-27' }],
  partial: false,
  applied: [
    {
      resourceKey: 'skill:gh',
      environmentId: 'local',
      locationId: 'claude-skills',
      operation: 'overwrite',
      destinationPath: '/home/dev/.claude/skills/gh',
      contentHash: 'a3f9c1',
    },
  ],
  skipped: [
    {
      resourceKey: 'skill:tdd',
      environmentId: 'local',
      locationId: 'codex-skills',
      reason: 'already-in-sync',
    },
  ],
  failed: [],
};

describe('ResultPanel', () => {
  it('offers undo with the backup the apply returned', async () => {
    const onUndo = jest.fn();
    render(
      <ResultPanel
        environmentName={(id: string) => id}
        result={applied}
        undoResult={undefined}
        isUndoing={false}
        undoError={null}
        onUndo={onUndo}
      />
    );

    expect(screen.getByText(/backup-2026-07-27/)).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('undo-button'));

    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it('reports what the undo restored and what it left alone', () => {
    const undone: PropagationUndo = {
      backupId: 'backup-2026-07-27',
      environmentId: 'local',
      restored: [{ locationId: 'claude-skills', destinationPath: '/home/dev/.claude/skills/gh' }],
      removed: [],
      skipped: [
        {
          locationId: 'codex-skills',
          destinationPath: '/home/dev/.codex/skills/gh',
          reason: 'changed-since-apply',
        },
      ],
    };

    render(
      <ResultPanel
        environmentName={(id: string) => id}
        result={applied}
        undoResult={undone}
        isUndoing={false}
        undoError={null}
        onUndo={() => undefined}
      />
    );

    expect(screen.getByTestId('undo-result')).toHaveTextContent('1');
    // A destination edited after the apply is deliberately not reverted, and
    // saying so is the difference between a safe undo and a surprising one.
    expect(screen.getByTestId('undo-result')).toHaveTextContent(
      en.library.result.undoSkipReason['changed-since-apply']
    );
    expect(screen.queryByTestId('undo-button')).not.toBeInTheDocument();
  });

  it('shouts when a failure could not be fully rolled back', () => {
    render(
      <ResultPanel
        environmentName={(id: string) => id}
        result={{
          ...applied,
          partial: true,
          failed: [
            {
              resourceKey: 'skill:gh',
              environmentId: 'local',
              locationId: 'codex-skills',
              reason: 'write-failed',
              message: 'EACCES',
            },
          ],
        }}
        undoResult={undefined}
        isUndoing={false}
        undoError={null}
        onUndo={() => undefined}
      />
    );

    expect(screen.getByTestId('partial-warning')).toHaveTextContent(en.library.result.partial);
    expect(screen.getByTestId('failed-row')).toHaveTextContent(
      en.library.failureReason['write-failed']
    );
  });

  it('says nothing was written when a failure rolled back cleanly', () => {
    render(
      <ResultPanel
        environmentName={(id: string) => id}
        result={{
          partial: false,
          backups: [],
          applied: [],
          skipped: [],
          failed: [
            {
              resourceKey: 'skill:gh',
              environmentId: 'local',
              locationId: 'codex-skills',
              reason: 'verification-failed',
              message: 'hash mismatch',
            },
          ],
        }}
        undoResult={undefined}
        isUndoing={false}
        undoError={null}
        onUndo={() => undefined}
      />
    );

    expect(screen.getByTestId('rolled-back')).toHaveTextContent(en.library.result.rolledBack);
    expect(screen.queryByTestId('partial-warning')).not.toBeInTheDocument();
  });

  it('names why each skipped destination was skipped', () => {
    render(
      <ResultPanel
        environmentName={(id: string) => id}
        result={applied}
        undoResult={undefined}
        isUndoing={false}
        undoError={null}
        onUndo={() => undefined}
      />
    );

    expect(screen.getByTestId('skipped-row')).toHaveTextContent(
      en.library.skipReason['already-in-sync']
    );
  });
});
