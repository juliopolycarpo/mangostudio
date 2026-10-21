import { describe, expect, it, jest } from 'bun:test';
import type {
  PromptSettings as PromptSettingsData,
  RuleFileSetting,
} from '@mangostudio/shared/prompt-rules';
import { fireEvent, screen, within } from '@testing-library/react';
import { PromptSettings } from '../../../src/components/settings/PromptSettings';
import { DEFAULT_PROMPT_SETTINGS } from '../../../src/hooks/use-global-settings';
import { render } from '../../support/harness/render';

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
    onTextSystemPromptChange: jest.fn(),
    onImageSystemPromptChange: jest.fn(),
    onUpdateRuleFile: jest.fn(),
    onAddCustomRule: jest.fn(),
    onRemoveCustomRule: jest.fn(),
    ...overrides,
  };

  render(<PromptSettings {...props} />);
  return props;
}

describe('PromptSettings', () => {
  it('renders the default prompts section with textareas', () => {
    renderPromptSettings();

    expect(screen.getByText('Default text system prompt')).toBeInTheDocument();
    expect(screen.getByText('Default image system prompt')).toBeInTheDocument();
    expect(screen.getByLabelText('Default text system prompt')).toBeInTheDocument();
    expect(screen.getByLabelText('Default image system prompt')).toBeInTheDocument();
  });

  it('renders fixed rule cards with correct paths', () => {
    renderPromptSettings();

    expect(screen.getByText('~/.mango/AGENTS.md')).toBeInTheDocument();
    expect(screen.getByText('~/.claude/CLAUDE.md')).toBeInTheDocument();
  });

  it('draws each rule file as a card of its own, holding only its three rows', () => {
    renderPromptSettings();

    for (const path of ['~/.mango/AGENTS.md', '~/.claude/CLAUDE.md']) {
      const card = screen.getByText(path).closest('.divide-y');
      expect(card).not.toBeNull();
      if (!card) continue;
      expect(within(card as HTMLElement).getAllByRole('radiogroup')).toHaveLength(2);
    }
  });

  it('does not repeat the file name under a path that already ends in it', () => {
    renderPromptSettings();

    // The built-in labels are "AGENTS.md" / "CLAUDE.md", the basenames of their paths.
    expect(screen.queryByText('AGENTS.md')).not.toBeInTheDocument();
    expect(screen.queryByText('CLAUDE.md')).not.toBeInTheDocument();
  });

  it('keeps a hint that says more than the file name', () => {
    renderPromptSettings({
      promptSettings: createPromptSettings({
        agentsMd: { ...DEFAULT_PROMPT_SETTINGS.agentsMd, label: 'Project guidance' },
      }),
    });

    expect(screen.getByText('Project guidance')).toBeInTheDocument();
  });

  it('calls onTextSystemPromptChange when text prompt changes', () => {
    const props = renderPromptSettings();

    fireEvent.change(screen.getByLabelText('Default text system prompt'), {
      target: { value: 'You are a helpful assistant.' },
    });

    expect(props.onTextSystemPromptChange).toHaveBeenCalledWith('You are a helpful assistant.');
  });

  it('calls onImageSystemPromptChange when image prompt changes', () => {
    const props = renderPromptSettings();

    fireEvent.change(screen.getByLabelText('Default image system prompt'), {
      target: { value: 'Generate cinematic images.' },
    });

    expect(props.onImageSystemPromptChange).toHaveBeenCalledWith('Generate cinematic images.');
  });

  it('displays the rule file cards with toggles and radio groups', () => {
    renderPromptSettings();

    const enabledToggles = screen.getAllByRole('switch');
    expect(enabledToggles.length).toBeGreaterThanOrEqual(2);

    const injectionRoleLabels = screen.getAllByText('Injection role');
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

    expect(screen.getByText('Custom rules')).toBeInTheDocument();
  });

  it('says the custom rules list is empty instead of repeating the Add rule action', () => {
    renderPromptSettings();

    expect(screen.getByText('No custom rules yet')).toBeInTheDocument();
  });

  it('calls onAddCustomRule when Add rule button is clicked', () => {
    const props = renderPromptSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));

    expect(props.onAddCustomRule).toHaveBeenCalledTimes(1);
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

  it('names a built-in file switch by its row, with no "Enabled" word beside it', () => {
    renderPromptSettings();

    // The path is the row's name; a static word beside an off switch read as its state.
    expect(screen.getAllByRole('switch', { name: 'Enabled' })).toHaveLength(2);
    expect(screen.queryByText('Enabled')).not.toBeInTheDocument();
  });

  it('turns a built-in file on from anywhere on its row', () => {
    const props = renderPromptSettings();

    fireEvent.click(screen.getByText('~/.mango/AGENTS.md'));

    expect(props.onUpdateRuleFile).toHaveBeenCalledWith('agentsMd', { enabled: true });
  });

  it('keeps the "Enabled" word on a custom rule, whose path is a field and not a name', () => {
    renderPromptSettings({
      promptSettings: createPromptSettings({
        customRules: [
          {
            id: 'custom-1',
            label: '',
            path: '~/my-project/rules.md',
            enabled: true,
            injectionRole: 'system',
            sendFrequency: 'first-turn',
          },
        ],
      }),
    });

    expect(screen.getByText('Enabled')).toBeInTheDocument();
  });

  it('calls onUpdateRuleFile when a rule enabled toggle is clicked', () => {
    const props = renderPromptSettings();

    const switches = screen.getAllByRole('switch');
    fireEvent.click(switches[0]);

    expect(props.onUpdateRuleFile).toHaveBeenCalledWith('agentsMd', { enabled: true });
  });

  it('calls onUpdateRuleFile when injection role is changed', () => {
    const props = renderPromptSettings();

    const userRadios = screen.getAllByText('Send as user prompt');
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

  it('says what is recommended whichever frequency is selected', () => {
    renderPromptSettings();

    const hints = screen.getAllByText('Sending once per chat is recommended.');
    expect(hints.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the recommendation when every turn is selected, so the control does not jump', () => {
    renderPromptSettings({
      promptSettings: createPromptSettings({
        agentsMd: { ...DEFAULT_PROMPT_SETTINGS.agentsMd, sendFrequency: 'every-turn' },
        claudeMd: { ...DEFAULT_PROMPT_SETTINGS.claudeMd, sendFrequency: 'every-turn' },
      }),
    });

    // A hint that came and went with the choice moved the control up a line under the pointer.
    expect(screen.getAllByText('Sending once per chat is recommended.')).toHaveLength(2);
  });
});
