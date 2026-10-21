/**
 * The composer's status line. It is only drawn when it has a chip to carry, so
 * a runner whose controls would render nothing visible — one that is not
 * installed, or whose descriptor has not landed — leaves no empty band above the
 * prompt under the warning that explains it.
 */

import { describe, expect, it, jest } from 'bun:test';
import { join } from 'node:path';
import type { ExternalAgentDescriptor } from '@mangostudio/shared/external-agents';
import { NO_EXTERNAL_AGENT_CAPABILITIES } from '@mangostudio/shared/external-agents';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ComposerChipRow,
  type ComposerChipRowProps,
} from '../../../../src/features/chat/components/ComposerChipRow';
import { render } from '../../../support/harness/render';

function descriptor(overrides: Partial<ExternalAgentDescriptor> = {}): ExternalAgentDescriptor {
  return {
    targetId: 'codex',
    environmentId: 'local',
    installed: true,
    authState: 'signed-in',
    capabilities: NO_EXTERNAL_AGENT_CAPABILITIES,
    supportedConfigurations: [],
    ...overrides,
  };
}

function renderRow(overrides: Partial<ComposerChipRowProps> = {}) {
  const props: ComposerChipRowProps = {
    isExternalRunner: true,
    thinkingEnabled: false,
    reasoningEffort: 'medium',
    reasoningVisible: false,
    activeModel: null,
    selectedAgentId: 'default',
    isAgentListLoading: false,
    hasTurns: false,
    workdir: '/home/user/mangostudio',
    isModelSelectorDisabled: false,
    externalModel: null,
    externalEffort: null,
    externalLevel: 'default',
    externalRouting: 'user',
    onExternalModelChange: jest.fn(),
    onExternalEffortChange: jest.fn(),
    onExternalSelectionGone: jest.fn(),
    onExternalPermissionsChange: jest.fn(),
    ...overrides,
  };
  return render(<ComposerChipRow {...props} />);
}

describe('ComposerChipRow — external runner', () => {
  it('draws no strip for a runner that is not installed', () => {
    const { container } = renderRow({
      externalDescriptor: descriptor({ installed: false }),
    });

    expect(container.querySelector('.composer-statusline')).toBeNull();
    expect(container.querySelector('.composer-chip')).toBeNull();
  });

  it('draws no strip while the descriptor has not landed', () => {
    const { container } = renderRow({ externalDescriptor: undefined });

    expect(container.querySelector('.composer-statusline')).toBeNull();
  });

  it('draws the strip once the runner has a catalog to pick from', () => {
    const { container } = renderRow({
      externalDescriptor: descriptor({
        models: [{ id: 'gpt-5-codex', displayName: 'GPT-5 Codex', isDefault: true }],
      }),
    });

    expect(container.querySelector('.composer-statusline')).not.toBeNull();
    expect(screen.getByRole('combobox', { name: /model/i })).toBeInTheDocument();
  });
});

/**
 * On a phone the strip collapses behind a summary. Open, the controls underneath
 * already name the model, so the summary keeps only the folder; closed, it also
 * carries the one figure that changes during a session.
 */
describe('ComposerChipRow — phone summary', () => {
  const openModel = {
    models: [{ id: 'gpt-5-codex', displayName: 'GPT-5 Codex', isDefault: true }],
  };

  it('names the model and the folder while collapsed, and only the folder once open', async () => {
    const user = userEvent.setup();
    renderRow({
      externalDescriptor: descriptor(openModel),
      externalModel: 'GPT-5 Codex',
    });

    const summary = screen.getByRole('button', { name: /Show chat controls/ });
    expect(summary).toHaveTextContent('GPT-5 Codex · mangostudio');

    await user.click(summary);

    const open = screen.getByRole('button', { name: /Hide chat controls/ });
    expect(open).toHaveTextContent('mangostudio');
    expect(open).not.toHaveTextContent('GPT-5 Codex');
  });

  it('carries the context ring and its percentage while collapsed', async () => {
    const user = userEvent.setup();
    renderRow({
      externalDescriptor: descriptor(openModel),
      contextInfo: {
        estimatedInputTokens: 6200,
        contextLimit: 10000,
        estimatedUsageRatio: 0.62,
        mode: 'stateful',
        severity: 'normal',
      },
    });

    const summary = screen.getByRole('button', { name: /Show chat controls/ });
    expect(summary).toHaveTextContent('62%');

    await user.click(summary);
    expect(screen.getByRole('button', { name: /Hide chat controls/ })).not.toHaveTextContent('62%');
  });

  // The `·` between chips is drawn by the stylesheet, and only from `sm` up: a
  // phone wraps the strip, and a trailing dot left at the end of a line reads as
  // a stray bullet. The rule is gated by its media query, not undone by a
  // utility on each strip, so the markup carries nothing about it.
  describe('separators', () => {
    const stylesheet = Bun.file(join(import.meta.dir, '../../../../src/index.css')).text();
    // The one rule that draws a `·`, inside the `sm` media query.
    const GATED_SEPARATOR =
      /@media \(width >= 40rem\)\s*\{\s*\.composer-chip-row[^{]*::after\s*\{[^}]*content:\s*"·"[^}]*\}\s*\}/;

    it('are drawn from sm up only, by the stylesheet', async () => {
      const source = (await stylesheet).replace(/\/\*[\s\S]*?\*\//g, '');

      expect(source).toMatch(GATED_SEPARATOR);
      // Nowhere outside that block does a `.composer-chip-row` rule draw one.
      expect(source.replace(GATED_SEPARATOR, '')).not.toMatch(/\.composer-chip-row[^{]*::after/);
    });

    // The `·` is drawn inside the strip's child, so the child is always a slot
    // around a chip, never the chip itself (the dot landed in the pressed
    // `reasoning` chip's wash), and never a strip of its own (its gap doubled
    // the lead of the dot after it). Both runners' chips are checked.
    it.each([
      ['external', { externalDescriptor: descriptor(openModel) }],
      [
        'MangoStudio',
        {
          isExternalRunner: false,
          reasoningVisible: true,
          thinkingEnabled: true,
          onThinkingToggle: jest.fn(),
          onReasoningEffortChange: jest.fn(),
        },
      ],
    ] as const)('sit between slots, never inside a chip, for the %s runner', (_, overrides) => {
      const { container } = renderRow(overrides);

      const strips = container.querySelectorAll('.composer-chip-row');
      expect(strips).toHaveLength(1);
      const children = [...strips[0].children];
      expect(children.length).toBeGreaterThan(0);
      for (const child of children) {
        expect(child.classList.contains('composer-chip')).toBe(false);
      }
    });

    it('are not left to a utility on the strip', () => {
      const { container } = renderRow({ externalDescriptor: descriptor(openModel) });

      for (const strip of container.querySelectorAll('.composer-chip-row')) {
        expect(strip.className).not.toContain('content-none');
      }
    });
  });
});
