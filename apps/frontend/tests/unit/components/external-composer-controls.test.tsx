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
import { ExternalComposerControls } from '../../../src/features/external-agents/ExternalComposerControls';
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
    onPermissionsChange: jest.fn(),
    ...overrides,
  };
  return { ...render(<ExternalComposerControls {...props} />), props };
}

describe('ExternalComposerControls model reconciliation', () => {
  it('clears a model the refreshed catalog no longer offers, and its effort with it', () => {
    const { props } = renderControls({
      descriptor: descriptor([{ id: 'gpt-5-codex', displayName: 'GPT-5 Codex', isDefault: true }]),
      model: 'gpt-5',
      effort: 'high',
    });

    expect(props.onModelChange).toHaveBeenCalledWith(null);
    expect(props.onEffortChange).toHaveBeenCalledWith(null);
  });

  it('clears a model the vendor has since marked hidden', () => {
    const { props } = renderControls({
      descriptor: descriptor([
        { id: 'gpt-5-codex', displayName: 'GPT-5 Codex', isDefault: true },
        { id: 'gpt-5', displayName: 'GPT-5', hidden: true },
      ]),
      model: 'gpt-5',
    });

    expect(props.onModelChange).toHaveBeenCalledWith(null);
  });

  it('leaves a selection the catalog still offers alone', () => {
    const { props } = renderControls({ model: 'gpt-5', effort: 'high' });

    expect(props.onModelChange).not.toHaveBeenCalled();
    expect(props.onEffortChange).not.toHaveBeenCalled();
  });

  it('treats an empty catalog as a refetch rather than a removal', () => {
    const { props } = renderControls({ descriptor: descriptor([]), model: 'gpt-5' });

    expect(props.onModelChange).not.toHaveBeenCalled();
  });

  it('treats a vendor with no catalog at all as nothing to reconcile against', () => {
    const { props } = renderControls({ descriptor: descriptor(undefined), model: 'gpt-5' });

    expect(props.onModelChange).not.toHaveBeenCalled();
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
    expect(picker).toHaveTextContent('effort:medium');
    await user.click(picker);
    await user.click(screen.getByRole('option', { name: 'high' }));

    expect(props.onEffortChange).toHaveBeenCalledWith('high');
  });

  it('renders no effort chip for a model that advertises none', () => {
    renderControls({ descriptor: descriptor(CODEX_MODELS), model: 'gpt-5' });

    expect(screen.queryByRole('combobox', { name: 'Reasoning effort' })).toBeNull();
  });
});
