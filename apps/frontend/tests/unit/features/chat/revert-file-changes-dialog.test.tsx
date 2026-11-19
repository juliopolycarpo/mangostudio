/**
 * The confirmation has to tell the truth before the user commits to it: a turn
 * whose shell or MCP writes were never checkpointed must say so where the
 * decision is made, not only in the result afterwards.
 */

import { describe, expect, it, jest } from 'bun:test';

import { en } from '@mangostudio/shared/i18n';
import { screen } from '@testing-library/react';

import { RevertFileChangesDialog } from '@/features/chat/components/RevertFileChangesDialog';

import { render } from '../../../support/harness/render';

const labels = en.chat.fileCheckpoints;

function renderDialog(
  uncheckpointedSources?: ReadonlyArray<'shell' | 'mcp'>,
  includesShellCapture?: boolean
) {
  return render(
    <RevertFileChangesDialog
      isReverting={false}
      uncheckpointedSources={uncheckpointedSources}
      includesShellCapture={includesShellCapture}
      onConfirm={jest.fn()}
      onCancel={jest.fn()}
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

  it('warns that a revert may undo another program’s edits only when shell captures are in it', () => {
    renderDialog([], true);

    expect(screen.getByText(labels.shellCaptureNote)).toBeTruthy();
  });

  it.each([
    ['a turn with no shell capture', [], false],
    ['a turn whose preview did not say', undefined, undefined],
    ['an MCP-only turn', ['mcp'] as const, false],
  ])('says nothing about concurrent writers for %s', (_name, sources, includesShellCapture) => {
    renderDialog(sources, includesShellCapture);

    // The sentence would be false here: no row came from a before/after comparison.
    expect(document.body.textContent ?? '').not.toContain(labels.shellCaptureNote);
    expect(document.body.textContent ?? '').not.toMatch(/another program/i);
  });

  it('renders no warning when the caller has no preview to pass', () => {
    renderDialog(undefined);

    expect(screen.getByText(labels.confirmTitle)).toBeTruthy();
    expect(screen.queryByText(labels.uncheckpointedBoth)).toBeNull();
  });
});
