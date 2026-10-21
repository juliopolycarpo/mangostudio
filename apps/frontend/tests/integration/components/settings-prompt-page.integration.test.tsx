/**
 * Integration tests for the Prompt settings page.
 */

import { describe, expect, it, jest } from 'bun:test';
import { fireEvent, screen } from '@testing-library/react';
import { PromptSettings } from '../../../src/components/settings/PromptSettings';
import { DEFAULT_PROMPT_SETTINGS } from '../../../src/hooks/use-global-settings';
import { render } from '../../support/harness/render';

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

    expect(screen.getByText('Default text system prompt')).toBeInTheDocument();
    expect(screen.getByText('Default image system prompt')).toBeInTheDocument();
    expect(screen.getByText('Rule files')).toBeInTheDocument();
    expect(screen.getByText('Custom rules')).toBeInTheDocument();
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

    const textarea = screen.getByLabelText('Default text system prompt');
    fireEvent.change(textarea, { target: { value: 'Be concise.' } });

    expect(props.onTextSystemPromptChange).toHaveBeenCalledWith('Be concise.');
  });

  it('allows editing image system prompt and calls the handler', () => {
    const props = createDefaultProps();
    render(<PromptSettings {...props} />);

    const textarea = screen.getByLabelText('Default image system prompt');
    fireEvent.change(textarea, { target: { value: '4K cinematic.' } });

    expect(props.onImageSystemPromptChange).toHaveBeenCalledWith('4K cinematic.');
  });

  it('adds a custom rule when clicking Add rule', () => {
    const props = createDefaultProps();
    render(<PromptSettings {...props} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));

    expect(props.onAddCustomRule).toHaveBeenCalledTimes(1);
  });

  it('shows injection role and frequency radio groups on fixed rules that are on', () => {
    const props = {
      ...createDefaultProps(),
      promptSettings: {
        ...DEFAULT_PROMPT_SETTINGS,
        agentsMd: { ...DEFAULT_PROMPT_SETTINGS.agentsMd, enabled: true },
        claudeMd: { ...DEFAULT_PROMPT_SETTINGS.claudeMd, enabled: true },
      },
    };
    render(<PromptSettings {...props} />);

    const radiogroups = screen.getAllByRole('radiogroup');
    expect(radiogroups.length).toBeGreaterThanOrEqual(4); // 2 fixed rules × 2 groups each
  });
});
