/**
 * The pieces the settings editors (agents, MCP servers, tools) share beyond the
 * page frame: a labelled field, a checkbox row, a one-line status note, and the
 * loading and failed-load states of a list. Pages test their own behaviour;
 * these pin what each piece promises to the pages that use it.
 */

import { describe, expect, it, jest } from 'bun:test';

import { fireEvent, screen } from '@testing-library/react';

import { CheckboxRow } from '../../../src/components/settings/CheckboxRow';
import { SettingsField } from '../../../src/components/settings/SettingsField';
import {
  SettingsLoadError,
  SettingsLoading,
} from '../../../src/components/settings/SettingsStates';
import { StatusNote } from '../../../src/components/settings/StatusNote';
import { render } from '../../support/harness/render';

describe('SettingsField', () => {
  it('ties the visible name to the control and puts the hint after it', () => {
    render(
      <SettingsField label="Slug" htmlFor="slug" hint="Lowercase letters only.">
        <input id="slug" />
      </SettingsField>
    );

    expect(screen.getByLabelText('Slug')).toBeInTheDocument();
    expect(screen.getByText('Lowercase letters only.')).toBeInTheDocument();
  });

  it('names a group of controls without a label element', () => {
    render(
      <SettingsField label="Transport">
        <button type="button">stdio</button>
      </SettingsField>
    );

    expect(screen.getByText('Transport').tagName).toBe('SPAN');
  });
});

describe('CheckboxRow', () => {
  it('reports the new checked state when its row is clicked', () => {
    const onChange = jest.fn();
    render(<CheckboxRow label="Read file" description="read_file" checked onChange={onChange} />);

    fireEvent.click(screen.getByText('Read file'));

    expect(onChange).toHaveBeenCalledWith(false);
    expect(screen.getByText('read_file')).toBeInTheDocument();
  });

  it('is named by its label and turned off by an enclosing disabled fieldset', () => {
    render(
      <fieldset disabled>
        <CheckboxRow label="List directory" checked={false} onChange={() => undefined} />
      </fieldset>
    );

    expect(screen.getByRole('checkbox', { name: 'List directory' })).toBeDisabled();
  });
});

describe('StatusNote', () => {
  it('says the words in plain text beside a glyph, as a span where a paragraph is not allowed', () => {
    render(
      <StatusNote
        as="span"
        tone="danger"
        // eslint-disable-next-line jsx-a11y/prefer-tag-over-role -- The status live region announces changes without implying a calculation output.
        role="status"
      >
        Connection failed
      </StatusNote>
    );

    const note = screen.getByRole('status');
    expect(note).toHaveTextContent('Connection failed');
    expect(note.tagName).toBe('SPAN');
    expect(note.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('SettingsLoading', () => {
  it('is a status region that says Loading for a screen reader', () => {
    render(<SettingsLoading count={2} />);

    expect(screen.getByRole('status')).toHaveTextContent(/loading/i);
  });
});

describe('SettingsLoadError', () => {
  it('offers a retry only when it is given something to retry', () => {
    const onRetry = jest.fn();
    const { rerender } = render(<SettingsLoadError message="Failed to load tools" />);

    expect(screen.getByText('Failed to load tools')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();

    rerender(<SettingsLoadError message="Failed to load tools" onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
