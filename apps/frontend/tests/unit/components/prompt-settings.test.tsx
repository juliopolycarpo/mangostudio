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

/** Both built-in files switched on, so their role and frequency rows are drawn. */
function createEnabledPromptSettings(overrides?: Partial<PromptSettingsData>): PromptSettingsData {
  return createPromptSettings({
    agentsMd: { ...DEFAULT_PROMPT_SETTINGS.agentsMd, enabled: true },
    claudeMd: { ...DEFAULT_PROMPT_SETTINGS.claudeMd, enabled: true },
    ...overrides,
  });
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
    renderPromptSettings({ promptSettings: createEnabledPromptSettings() });

    for (const path of ['~/.mango/AGENTS.md', '~/.claude/CLAUDE.md']) {
      const card = screen.getByText(path).closest('.divide-y');
      expect(card).not.toBeNull();
      if (!card) continue;
      expect(within(card as HTMLElement).getAllByRole('radiogroup')).toHaveLength(2);
    }
  });

  it('draws a file that is off as its path row alone, keeping its role and frequency', () => {
    renderPromptSettings({
      promptSettings: createPromptSettings({
        agentsMd: { ...DEFAULT_PROMPT_SETTINGS.agentsMd, enabled: false },
        claudeMd: { ...DEFAULT_PROMPT_SETTINGS.claudeMd, enabled: true },
      }),
    });

    const offCard = screen.getByText('~/.mango/AGENTS.md').closest('.divide-y');
    expect(offCard).not.toBeNull();
    if (!offCard) return;
    expect(within(offCard as HTMLElement).getByRole('switch')).not.toBeChecked();
    expect(within(offCard as HTMLElement).queryByRole('radiogroup')).not.toBeInTheDocument();
    // Only the file that is on carries the two settings rows.
    expect(screen.getAllByRole('radiogroup')).toHaveLength(2);
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
    renderPromptSettings({ promptSettings: createEnabledPromptSettings() });

    const enabledToggles = screen.getAllByRole('switch');
    expect(enabledToggles.length).toBeGreaterThanOrEqual(2);

    const injectionRoleLabels = screen.getAllByText('Injection role');
    expect(injectionRoleLabels.length).toBeGreaterThanOrEqual(2);

    const frequencyLabels = screen.getAllByText('Frequency');
    expect(frequencyLabels.length).toBeGreaterThanOrEqual(2);
  });

  it('shows radio groups for injection roles on rule cards', () => {
    renderPromptSettings({ promptSettings: createEnabledPromptSettings() });

    const radiogroups = screen.getAllByRole('radiogroup');
    expect(radiogroups.length).toBeGreaterThanOrEqual(2);
  });

  it('renders custom rules section', () => {
    renderPromptSettings();

    expect(screen.getByText('Custom rules')).toBeInTheDocument();
  });

  it('says the custom rules list is empty and offers Add rule once, from the empty state', () => {
    renderPromptSettings();

    expect(screen.getByText('No custom rules yet')).toBeInTheDocument();
    expect(
      screen.getByText('Point a rule at a Markdown file to add it to every request.')
    ).toBeInTheDocument();
    // The header's Add is not drawn beside the empty state's own.
    expect(screen.getAllByRole('button', { name: 'Add rule' })).toHaveLength(1);
  });

  it('moves Add rule to the section header once a custom rule exists', () => {
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

    expect(screen.queryByText('No custom rules yet')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Add rule' })).toHaveLength(1);
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
    const props = renderPromptSettings({ promptSettings: createEnabledPromptSettings() });

    const userRadios = screen.getAllByText('Send as user prompt');
    fireEvent.click(userRadios[0]);

    expect(props.onUpdateRuleFile).toHaveBeenCalledWith('agentsMd', { injectionRole: 'user' });
  });

  it('calls onUpdateRuleFile when send frequency is changed', () => {
    const props = renderPromptSettings({ promptSettings: createEnabledPromptSettings() });

    const everyTurnRadios = screen.getAllByText('Send every time');
    fireEvent.click(everyTurnRadios[0]);

    expect(props.onUpdateRuleFile).toHaveBeenCalledWith('agentsMd', {
      sendFrequency: 'every-turn',
    });
  });

  it('says what is recommended whichever frequency is selected', () => {
    renderPromptSettings({ promptSettings: createEnabledPromptSettings() });

    const hints = screen.getAllByText('Sending once per chat is recommended.');
    expect(hints.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the recommendation when every turn is selected, so the control does not jump', () => {
    renderPromptSettings({
      promptSettings: createPromptSettings({
        agentsMd: {
          ...DEFAULT_PROMPT_SETTINGS.agentsMd,
          enabled: true,
          sendFrequency: 'every-turn',
        },
        claudeMd: {
          ...DEFAULT_PROMPT_SETTINGS.claudeMd,
          enabled: true,
          sendFrequency: 'every-turn',
        },
      }),
    });

    // A hint that came and went with the choice moved the control up a line under the pointer.
    expect(screen.getAllByText('Sending once per chat is recommended.')).toHaveLength(2);
  });
});
