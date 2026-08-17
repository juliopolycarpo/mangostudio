/**
 * The confirmation has to tell the truth before the user commits to it: a turn
 * whose shell or MCP writes were never checkpointed must say so where the
 * decision is made, not only in the result afterwards.
 */

import { en } from '@mangostudio/shared/i18n';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RevertFileChangesDialog } from '@/features/chat/components/RevertFileChangesDialog';
import { render } from '../../../support/harness/render';

const labels = en.chat.fileCheckpoints;

function renderDialog(uncheckpointedSources?: ReadonlyArray<'shell' | 'mcp'>) {
  return render(
    <RevertFileChangesDialog
      isReverting={false}
      uncheckpointedSources={uncheckpointedSources}
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
    />
  );
}

describe('RevertFileChangesDialog', () => {
  it('renders no warning when the manifest covered the turn', () => {
    renderDialog([]);

    expect(screen.getByText(labels.confirmTitle)).toBeTruthy();
    expect(screen.queryByText(labels.uncheckpointedShell)).toBeNull();
    expect(screen.queryByText(labels.uncheckpointedMcp)).toBeNull();
    expect(screen.queryByText(labels.uncheckpointedBoth)).toBeNull();
  });

  it('names the shell writes it will leave in place', () => {
    renderDialog(['shell']);

    expect(screen.getByText(labels.uncheckpointedShell)).toBeTruthy();
    expect(screen.queryByText(labels.uncheckpointedMcp)).toBeNull();
  });

  it('names MCP tools without claiming they wrote', () => {
    renderDialog(['mcp']);

    expect(screen.getByText(labels.uncheckpointedMcp)).toBeTruthy();
    expect(screen.queryByText(labels.uncheckpointedShell)).toBeNull();
  });

  it('combines both sources into one sentence', () => {
    renderDialog(['shell', 'mcp']);

    expect(screen.getByText(labels.uncheckpointedBoth)).toBeTruthy();
  });

  it('renders no warning when the caller has no preview to pass', () => {
    renderDialog(undefined);

    expect(screen.getByText(labels.confirmTitle)).toBeTruthy();
    expect(screen.queryByText(labels.uncheckpointedBoth)).toBeNull();
  });
});
