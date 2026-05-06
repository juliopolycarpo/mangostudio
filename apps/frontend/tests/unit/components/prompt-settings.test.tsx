import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { render } from '../../support/harness/render';
import { PromptSettings } from '../../../src/components/settings/PromptSettings';
import { DEFAULT_PROMPT_SETTINGS } from '../../../src/hooks/use-global-settings';
import type {
  PromptSettings as PromptSettingsData,
  RuleFileSetting,
} from '@mangostudio/shared/prompt-rules';

function createPromptSettings(overrides?: Partial<PromptSettingsData>): PromptSettingsData {
  return {
    ...DEFAULT_PROMPT_SETTINGS,
    ...overrides,
    customRules: overrides?.customRules ?? [],
  };
}

function renderPromptSettings(
  overrides: Partial<React.ComponentProps<typeof PromptSettings>> = {}
) {
  const props: React.ComponentProps<typeof PromptSettings> = {
    promptSettings: createPromptSettings(),
    onTextSystemPromptChange: vi.fn(),
    onImageSystemPromptChange: vi.fn(),
    onUpdateRuleFile: vi.fn(),
    onAddCustomRule: vi.fn(),
    onRemoveCustomRule: vi.fn(),
    ...overrides,
  };

  render(<PromptSettings {...props} />);
  return props;
}

describe('PromptSettings', () => {
  it('renders the default prompts section with textareas', () => {
    renderPromptSettings();

    expect(screen.getByText('Default Text System Prompt')).toBeInTheDocument();
    expect(screen.getByText('Default Image System Prompt')).toBeInTheDocument();
    expect(screen.getByLabelText('Default Text System Prompt')).toBeInTheDocument();
    expect(screen.getByLabelText('Default Image System Prompt')).toBeInTheDocument();
  });

  it('renders fixed rule cards with correct paths', () => {
    renderPromptSettings();

    expect(screen.getByText('~/.mango/AGENTS.md')).toBeInTheDocument();
    expect(screen.getByText('~/.claude/CLAUDE.md')).toBeInTheDocument();
  });

  it('calls onTextSystemPromptChange when text prompt changes', () => {
    const props = renderPromptSettings();

    fireEvent.change(screen.getByLabelText('Default Text System Prompt'), {
      target: { value: 'You are a helpful assistant.' },
    });

    expect(props.onTextSystemPromptChange).toHaveBeenCalledWith('You are a helpful assistant.');
  });

  it('calls onImageSystemPromptChange when image prompt changes', () => {
    const props = renderPromptSettings();

    fireEvent.change(screen.getByLabelText('Default Image System Prompt'), {
      target: { value: 'Generate cinematic images.' },
    });

    expect(props.onImageSystemPromptChange).toHaveBeenCalledWith('Generate cinematic images.');
  });

  it('displays the rule file cards with toggles and radio groups', () => {
    renderPromptSettings();

    const enabledToggles = screen.getAllByRole('switch');
    expect(enabledToggles.length).toBeGreaterThanOrEqual(2);

    const injectionRoleLabels = screen.getAllByText('Injection Role');
    expect(injectionRoleLabels.length).toBeGreaterThanOrEqual(2);

    const frequencyLabels = screen.getAllByText('Frequency');
    expect(frequencyLabels.length).toBeGreaterThanOrEqual(2);
  });

  it('shows radio groups for injection roles on rule cards', () => {
    renderPromptSettings();

    const radiogroups = screen.getAllByRole('radiogroup');
    expect(radiogroups.length).toBeGreaterThanOrEqual(2);
  });

  it('renders custom rules section', () => {
    renderPromptSettings();

    expect(screen.getByText('Custom Rules')).toBeInTheDocument();
  });

  it('calls onAddCustomRule when Add Rule button is clicked', () => {
    const props = renderPromptSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Add Rule' }));

    expect(props.onAddCustomRule).toHaveBeenCalledOnce();
  });

  it('renders custom rule cards with editable path and remove button', () => {
    const customRules: RuleFileSetting[] = [
      {
        id: 'custom-1',
        label: '',
        path: '~/my-project/rules.md',
        enabled: true,
        injectionRole: 'system',
        sendFrequency: 'first-turn',
      },
    ];

    renderPromptSettings({
      promptSettings: createPromptSettings({ customRules }),
    });

    expect(screen.getByLabelText('Path')).toHaveValue('~/my-project/rules.md');
  });

  it('calls onRemoveCustomRule when remove button is clicked', () => {
    const customRules: RuleFileSetting[] = [
      {
        id: 'custom-1',
        label: '',
        path: '~/my-project/rules.md',
        enabled: true,
        injectionRole: 'system',
        sendFrequency: 'first-turn',
      },
    ];

    const props = renderPromptSettings({
      promptSettings: createPromptSettings({ customRules }),
    });

    fireEvent.click(screen.getByText('Remove'));

    expect(props.onRemoveCustomRule).toHaveBeenCalledWith('custom-1');
  });

  it('calls onUpdateRuleFile when a rule enabled toggle is clicked', () => {
    const props = renderPromptSettings();

    const switches = screen.getAllByRole('switch');
    fireEvent.click(switches[0]);

    expect(props.onUpdateRuleFile).toHaveBeenCalledWith('agentsMd', { enabled: true });
  });

  it('calls onUpdateRuleFile when injection role is changed', () => {
    const props = renderPromptSettings();

    const userRadios = screen.getAllByText('Send as User Prompt');
    fireEvent.click(userRadios[0]);

    expect(props.onUpdateRuleFile).toHaveBeenCalledWith('agentsMd', { injectionRole: 'user' });
  });

  it('calls onUpdateRuleFile when send frequency is changed', () => {
    const props = renderPromptSettings();

    const everyTurnRadios = screen.getAllByText('Send every time');
    fireEvent.click(everyTurnRadios[0]);

    expect(props.onUpdateRuleFile).toHaveBeenCalledWith('agentsMd', {
      sendFrequency: 'every-turn',
    });
  });

  it('shows recommended hint when frequency is first-turn', () => {
    renderPromptSettings();

    const hints = screen.getAllByText('Recommended');
    expect(hints.length).toBeGreaterThanOrEqual(2);
  });
});
