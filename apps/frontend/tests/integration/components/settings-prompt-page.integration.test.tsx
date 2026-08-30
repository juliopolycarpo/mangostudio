/**
 * Integration tests for the Prompt settings page.
 */

import { describe, expect, it, jest, mock } from 'bun:test';
import { fireEvent, screen } from '@testing-library/react';
import { DEFAULT_PROMPT_SETTINGS } from '../../../src/hooks/use-global-settings';
import { render } from '../../support/harness/render';
import { routerWithLinkStub } from '../../support/mocks/router';

// Registered before the subjects are imported: `mock.module` is not hoisted and
// static imports are.
mock.module('@tanstack/react-router', await routerWithLinkStub());

const { PromptSettings } = await import('../../../src/components/settings/PromptSettings');

function createDefaultProps() {
  return {
    promptSettings: DEFAULT_PROMPT_SETTINGS,
    onTextSystemPromptChange: jest.fn(),
    onImageSystemPromptChange: jest.fn(),
    onUpdateRuleFile: jest.fn(),
    onAddCustomRule: jest.fn(),
    onRemoveCustomRule: jest.fn(),
  };
}

describe('Settings Prompts Page — Integration', () => {
  it('renders the default prompts section', () => {
    const props = createDefaultProps();
    render(<PromptSettings {...props} />);

    expect(screen.getByText('Default Text System Prompt')).toBeInTheDocument();
    expect(screen.getByText('Default Image System Prompt')).toBeInTheDocument();
    expect(screen.getByText('Rule Files')).toBeInTheDocument();
    expect(screen.getByText('Custom Rules')).toBeInTheDocument();
  });

  it('renders both fixed rule paths', () => {
    const props = createDefaultProps();
    render(<PromptSettings {...props} />);

    expect(screen.getByText('~/.mango/AGENTS.md')).toBeInTheDocument();
    expect(screen.getByText('~/.claude/CLAUDE.md')).toBeInTheDocument();
  });

  it('allows editing text system prompt and calls the handler', () => {
    const props = createDefaultProps();
    render(<PromptSettings {...props} />);

    const textarea = screen.getByLabelText('Default Text System Prompt');
    fireEvent.change(textarea, { target: { value: 'Be concise.' } });

    expect(props.onTextSystemPromptChange).toHaveBeenCalledWith('Be concise.');
  });

  it('allows editing image system prompt and calls the handler', () => {
    const props = createDefaultProps();
    render(<PromptSettings {...props} />);

    const textarea = screen.getByLabelText('Default Image System Prompt');
    fireEvent.change(textarea, { target: { value: '4K cinematic.' } });

    expect(props.onImageSystemPromptChange).toHaveBeenCalledWith('4K cinematic.');
  });

  it('adds a custom rule when clicking Add Rule', () => {
    const props = createDefaultProps();
    render(<PromptSettings {...props} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add Rule' }));

    expect(props.onAddCustomRule).toHaveBeenCalledTimes(1);
  });

  it('shows injection role and frequency radio groups on fixed rules', () => {
    const props = createDefaultProps();
    render(<PromptSettings {...props} />);

    const radiogroups = screen.getAllByRole('radiogroup');
    expect(radiogroups.length).toBeGreaterThanOrEqual(4); // 2 fixed rules × 2 groups each
  });
});
