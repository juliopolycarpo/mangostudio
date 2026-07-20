import { DEFAULT_GIT_SETTINGS } from '@mangostudio/shared/app-settings';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { GitSettingsPage } from '@/features/settings/git';
import { render } from '../../support/harness/render';

vi.mock('@/hooks/use-model-catalog', () => ({
  catalogKeys: { all: ['model-catalog'] },
  useModelCatalog: () => ({
    catalog: {
      textModels: [
        {
          modelId: 'fast-model',
          resourceName: 'fast-model',
          displayName: 'Fast Model',
          supportedActions: ['generateContent'],
        },
      ],
    },
  }),
}));

describe('GitSettingsPage', () => {
  it('updates commit signing and sign-off preferences', async () => {
    const user = userEvent.setup();
    const setSignCommits = vi.fn();
    const setSignOff = vi.fn();
    const setPreferredCommitMessageModel = vi.fn();
    const setCommitMessageSystemPrompt = vi.fn();
    const resetCommitMessageSystemPrompt = vi.fn();
    const setCommitMessageMaxDiffKb = vi.fn();

    render(
      <GitSettingsPage
        settings={{ ...DEFAULT_GIT_SETTINGS, signCommits: false, signOff: true }}
        setSignCommits={setSignCommits}
        setSignOff={setSignOff}
        setPreferredCommitMessageModel={setPreferredCommitMessageModel}
        setCommitMessageSystemPrompt={setCommitMessageSystemPrompt}
        resetCommitMessageSystemPrompt={resetCommitMessageSystemPrompt}
        setCommitMessageMaxDiffKb={setCommitMessageMaxDiffKb}
      />
    );

    expect(screen.getByText('Uses your Git config signing key — GPG or SSH.')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Sign commits' }));
    await user.click(screen.getByRole('checkbox', { name: 'Add Signed-off-by trailer' }));

    expect(setSignCommits).toHaveBeenCalledWith(true);
    expect(setSignOff).toHaveBeenCalledWith(false);

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Preferred model' }),
      'fast-model'
    );
    expect(setPreferredCommitMessageModel).toHaveBeenCalledWith('fast-model');

    const prompt = screen.getByRole('textbox', { name: 'System prompt' });
    fireEvent.change(prompt, { target: { value: 'Custom prompt' } });
    fireEvent.blur(prompt);
    expect(setCommitMessageSystemPrompt).toHaveBeenLastCalledWith('Custom prompt');

    const maxDiff = screen.getByRole('spinbutton', { name: 'Maximum diff size (KB)' });
    fireEvent.change(maxDiff, { target: { value: '200' } });
    fireEvent.blur(maxDiff);
    expect(setCommitMessageMaxDiffKb).toHaveBeenLastCalledWith(200);

    await user.click(screen.getByRole('button', { name: 'Reset to default' }));
    expect(resetCommitMessageSystemPrompt).toHaveBeenCalledOnce();
  });

  it('keeps the diff budget editable while typing and clamps it on blur', () => {
    const setCommitMessageMaxDiffKb = vi.fn();

    render(
      <GitSettingsPage
        settings={DEFAULT_GIT_SETTINGS}
        setSignCommits={vi.fn()}
        setSignOff={vi.fn()}
        setPreferredCommitMessageModel={vi.fn()}
        setCommitMessageSystemPrompt={vi.fn()}
        resetCommitMessageSystemPrompt={vi.fn()}
        setCommitMessageMaxDiffKb={setCommitMessageMaxDiffKb}
      />
    );

    // "2" is below the minimum but is a valid prefix of "256"; clamping it mid-edit would
    // rewrite the field and make larger values impossible to type.
    const maxDiff = screen.getByRole('spinbutton', { name: 'Maximum diff size (KB)' });
    fireEvent.change(maxDiff, { target: { value: '2' } });
    expect(maxDiff).toHaveValue(2);
    expect(setCommitMessageMaxDiffKb).not.toHaveBeenCalled();

    fireEvent.change(maxDiff, { target: { value: '256' } });
    fireEvent.blur(maxDiff);
    expect(setCommitMessageMaxDiffKb).toHaveBeenLastCalledWith(256);

    fireEvent.change(maxDiff, { target: { value: '' } });
    fireEvent.blur(maxDiff);
    expect(setCommitMessageMaxDiffKb).toHaveBeenLastCalledWith(
      DEFAULT_GIT_SETTINGS.commitMessage.maxDiffKb
    );
  });

  it('allows replacing the full prompt and restores the default for blank input', () => {
    const setCommitMessageSystemPrompt = vi.fn();

    render(
      <GitSettingsPage
        settings={DEFAULT_GIT_SETTINGS}
        setSignCommits={vi.fn()}
        setSignOff={vi.fn()}
        setPreferredCommitMessageModel={vi.fn()}
        setCommitMessageSystemPrompt={setCommitMessageSystemPrompt}
        resetCommitMessageSystemPrompt={vi.fn()}
        setCommitMessageMaxDiffKb={vi.fn()}
      />
    );

    const prompt = screen.getByRole('textbox', { name: 'System prompt' });
    fireEvent.change(prompt, { target: { value: '' } });
    expect(prompt).toHaveValue('');
    fireEvent.blur(prompt);

    expect(prompt).toHaveValue(DEFAULT_GIT_SETTINGS.commitMessage.systemPrompt);
    expect(setCommitMessageSystemPrompt).toHaveBeenLastCalledWith(
      DEFAULT_GIT_SETTINGS.commitMessage.systemPrompt
    );
  });
});
