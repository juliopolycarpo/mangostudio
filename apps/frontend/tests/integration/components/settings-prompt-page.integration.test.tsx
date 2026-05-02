/**
 * Integration tests for the Prompt settings page.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { render } from '../../support/harness/render';
import { PromptSettings } from '../../../src/components/settings/PromptSettings';
import { SettingsTabs } from '../../../src/components/settings/SettingsTabs';
import { DEFAULT_PROMPT_SETTINGS } from '../../../src/hooks/use-global-settings';

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual('@tanstack/react-router');
  return {
    ...actual,
    Link: ({
      to,
      children,
      activeProps: _activeProps,
      inactiveProps: _inactiveProps,
      activeOptions: _activeOptions,
      ...props
    }: {
      to: string;
      children: React.ReactNode;
      activeProps?: unknown;
      inactiveProps?: unknown;
      activeOptions?: unknown;
      [key: string]: unknown;
    }) => (
      <a href={to} {...props}>
        {children}
      </a>
    ),
  };
});

function createDefaultProps() {
  return {
    promptSettings: DEFAULT_PROMPT_SETTINGS,
    onTextSystemPromptChange: vi.fn(),
    onImageSystemPromptChange: vi.fn(),
    onUpdateRuleFile: vi.fn(),
    onAddCustomRule: vi.fn(),
    onRemoveCustomRule: vi.fn(),
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

    expect(props.onAddCustomRule).toHaveBeenCalledOnce();
  });

  it('shows injection role and frequency radio groups on fixed rules', () => {
    const props = createDefaultProps();
    render(<PromptSettings {...props} />);

    const radiogroups = screen.getAllByRole('radiogroup');
    expect(radiogroups.length).toBeGreaterThanOrEqual(4); // 2 fixed rules × 2 groups each
  });
});

describe('SettingsTabs includes Prompts', () => {
  it('renders a Prompts tab linking to /settings/prompts', () => {
    render(<SettingsTabs />);

    expect(screen.getByRole('link', { name: 'Prompts' })).toHaveAttribute(
      'href',
      '/settings/prompts'
    );
  });
});
