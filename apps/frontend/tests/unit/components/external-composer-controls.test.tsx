/**
 * What the composer sends has to be what the composer shows.
 *
 * The hub honours an explicitly requested model even when the vendor marked it
 * `hidden`, so a selection that leaves the visible catalog is the one case where
 * the picker and the turn can disagree about what is running.
 */

import { describe, expect, it, jest } from 'bun:test';
import type { ExternalAgentDescriptor } from '@mangostudio/shared/external-agents';
import { NO_EXTERNAL_AGENT_CAPABILITIES } from '@mangostudio/shared/external-agents';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ExternalComposerControls,
  hasExternalComposerControls,
} from '../../../src/features/external-agents/ExternalComposerControls';
import { render } from '../../support/harness/render';

function descriptor(
  models: ExternalAgentDescriptor['models'],
  overrides: Partial<ExternalAgentDescriptor> = {}
): ExternalAgentDescriptor {
  return {
    targetId: 'codex',
    environmentId: 'local',
    installed: true,
    authState: 'signed-in',
    capabilities: NO_EXTERNAL_AGENT_CAPABILITIES,
    supportedConfigurations: [],
    ...(models && { models }),
    ...overrides,
  };
}

function renderControls(
  overrides: Partial<React.ComponentProps<typeof ExternalComposerControls>> = {}
) {
  const props = {
    descriptor: descriptor([
      { id: 'gpt-5-codex', displayName: 'GPT-5 Codex', isDefault: true },
      { id: 'gpt-5', displayName: 'GPT-5' },
    ]),
    model: null,
    effort: null,
    level: 'default' as const,
    routing: 'user' as const,
    onModelChange: jest.fn(),
    onEffortChange: jest.fn(),
    onSelectionGone: jest.fn(),
    onPermissionsChange: jest.fn(),
    ...overrides,
  };
  return { ...render(<ExternalComposerControls {...props} />), props };
}

describe('ExternalComposerControls model reconciliation', () => {
  it('reports a model the refreshed catalog no longer offers', () => {
    const { props } = renderControls({
      descriptor: descriptor([{ id: 'gpt-5-codex', displayName: 'GPT-5 Codex', isDefault: true }]),
      model: 'gpt-5',
      effort: 'high',
    });

    expect(props.onSelectionGone).toHaveBeenCalledTimes(1);
  });

  /**
   * The one that matters: nobody picked anything, so a catalog that disagrees
   * for a render must not travel down the pick path — the caller persists a
   * pick, and the chat would forget the model the user stored.
   */
  it('reports it as gone rather than as a pick of nothing', () => {
    const { props } = renderControls({
      descriptor: descriptor([{ id: 'gpt-5-codex', displayName: 'GPT-5 Codex', isDefault: true }]),
      model: 'gpt-5',
      effort: 'high',
    });

    expect(props.onModelChange).not.toHaveBeenCalled();
    expect(props.onEffortChange).not.toHaveBeenCalled();
  });

  it('reports a model the vendor has since marked hidden', () => {
    const { props } = renderControls({
      descriptor: descriptor([
        { id: 'gpt-5-codex', displayName: 'GPT-5 Codex', isDefault: true },
        { id: 'gpt-5', displayName: 'GPT-5', hidden: true },
      ]),
      model: 'gpt-5',
    });

    expect(props.onSelectionGone).toHaveBeenCalledTimes(1);
  });

  it('leaves a selection the catalog still offers alone', () => {
    const { props } = renderControls({ model: 'gpt-5', effort: 'high' });

    expect(props.onSelectionGone).not.toHaveBeenCalled();
  });

  it('treats an empty catalog as a refetch rather than a removal', () => {
    const { props } = renderControls({ descriptor: descriptor([]), model: 'gpt-5' });

    expect(props.onSelectionGone).not.toHaveBeenCalled();
  });

  it('treats a vendor with no catalog at all as nothing to reconcile against', () => {
    const { props } = renderControls({ descriptor: descriptor(undefined), model: 'gpt-5' });

    expect(props.onSelectionGone).not.toHaveBeenCalled();
  });
});

/**
 * The effort vocabulary is the selected model's, not a global one, and it is
 * picked from the composer's own dropdown rather than the platform's.
 */
describe('ExternalComposerControls effort picker', () => {
  const CODEX_MODELS: ExternalAgentDescriptor['models'] = [
    {
      id: 'gpt-5-codex',
      displayName: 'GPT-5 Codex',
      isDefault: true,
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: [
        { id: 'low', displayName: 'low' },
        { id: 'high', displayName: 'high' },
      ],
    },
    { id: 'gpt-5', displayName: 'GPT-5' },
  ];

  it('offers the selected model efforts and reports the pick', async () => {
    const user = userEvent.setup();
    const { props } = renderControls({ descriptor: descriptor(CODEX_MODELS) });

    const picker = screen.getByRole('combobox', { name: 'Reasoning effort' });
    expect(picker).toHaveTextContent('effort:Medium');
    await user.click(picker);
    await user.click(screen.getByRole('option', { name: 'High' }));

    expect(props.onEffortChange).toHaveBeenCalledWith('high');
  });

  it('renders no effort chip for a model that advertises none', () => {
    renderControls({ descriptor: descriptor(CODEX_MODELS), model: 'gpt-5' });

    expect(screen.queryByRole('combobox', { name: 'Reasoning effort' })).toBeNull();
  });
});

/**
 * A vendor that sends bare ids still reads in the words MangoStudio's own menus
 * use, so the two runners do not disagree about what `xhigh` or `opus` is called.
 */
describe('ExternalComposerControls labels without a displayName', () => {
  const BARE_MODELS: ExternalAgentDescriptor['models'] = [
    {
      id: 'opus',
      isDefault: true,
      supportedReasoningEfforts: [{ id: 'low' }, { id: 'xhigh' }, { id: 'max' }],
    },
    { id: 'sonnet' },
    { id: 'claude-3-7-sonnet' },
  ];

  it('sentence-cases model ids that are plain words and leaves versioned ids alone', async () => {
    const user = userEvent.setup();
    renderControls({ descriptor: descriptor(BARE_MODELS) });

    const picker = screen.getByRole('combobox', { name: 'Agent model' });
    expect(picker).toHaveTextContent('model:Opus');
    await user.click(picker);
    expect(screen.getByRole('option', { name: 'Sonnet' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'claude-3-7-sonnet' })).toBeInTheDocument();
  });

  it("names efforts the way MangoStudio's own effort menu does", async () => {
    const user = userEvent.setup();
    renderControls({ descriptor: descriptor(BARE_MODELS) });

    await user.click(screen.getByRole('combobox', { name: 'Reasoning effort' }));
    expect(screen.getByRole('option', { name: 'Low' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Extra high' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Maximum' })).toBeInTheDocument();
  });
});

/**
 * The status line asks this before it draws a strip for the controls, so it has
 * to say "nothing to draw" exactly when the component would draw nothing: a
 * runner that is not installed answers no catalog and no permission pairs, and a
 * strip around that was twelve pixels of padding and a hairline above the prompt.
 */
describe('hasExternalComposerControls', () => {
  it('has nothing to draw for a descriptor with no catalog and no permission pairs', () => {
    expect(hasExternalComposerControls(descriptor(undefined, { installed: false }))).toBe(false);
    expect(hasExternalComposerControls(descriptor([]))).toBe(false);
  });

  it('has nothing to draw while the descriptor has not landed', () => {
    expect(hasExternalComposerControls(undefined)).toBe(false);
  });

  it('does not count a catalog the vendor marked entirely hidden', () => {
    expect(
      hasExternalComposerControls(
        descriptor([{ id: 'internal', displayName: 'Internal', hidden: true }])
      )
    ).toBe(false);
  });

  it('has a model picker to draw for a visible model', () => {
    expect(hasExternalComposerControls(descriptor([{ id: 'gpt-5', displayName: 'GPT-5' }]))).toBe(
      true
    );
  });

  it('has the permission control to draw for a vendor with pairs but no catalog', () => {
    expect(
      hasExternalComposerControls(
        descriptor(undefined, {
          supportedConfigurations: [
            { level: 'default', routing: 'user', supported: true, unattended: false },
          ],
        })
      )
    ).toBe(true);
  });
});
