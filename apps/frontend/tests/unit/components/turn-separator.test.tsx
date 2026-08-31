/**
 * What the turn separator calls the thing that produced the turn, and how it
 * draws it.
 *
 * An external turn stores `configuration.model ?? targetId`, so the bare vendor
 * id reaches this separator whenever the vendor resolved no model — and a vendor
 * id is a wire value, not a name the user should be shown.
 */

import { describe, expect, it } from 'bun:test';
import type { MessagePart } from '@mangostudio/shared';
import { createMockMessage } from '@mangostudio/shared/test-utils';
import { screen } from '@testing-library/react';
import { TurnSeparator } from '../../../src/features/chat/components/TurnSeparator';
import { deriveTurnStatus } from '../../../src/features/chat/lib/turn-status';
import { render } from '../../support/harness/render';

function renderSeparator(modelName: string | undefined, parts: MessagePart[] = []) {
  const msg = createMockMessage({ role: 'ai', modelName, isGenerating: false });
  return render(
    <TurnSeparator
      msg={msg}
      parts={parts}
      status={deriveTurnStatus(parts, false)}
      isImageTurn={false}
    />
  );
}

describe('TurnSeparator model name', () => {
  it('names a vendor by its label, not its target id', () => {
    renderSeparator('codex');

    expect(screen.getByText(/Codex CLI/i)).toBeInTheDocument();
  });

  // A vendor model id is already a name the user recognises, and it is not
  // ours to translate.
  it('leaves a model id alone', () => {
    renderSeparator('gpt-5-codex');

    expect(screen.getByText(/gpt-5-codex/i)).toBeInTheDocument();
  });

  // Exact match only: `claude` is a target id, `claude-opus-4` is a model that
  // merely starts with one.
  it('does not mistake a model that begins with a target id for the vendor', () => {
    renderSeparator('claude-opus-4');

    expect(screen.getByText(/claude-opus-4/i)).toBeInTheDocument();
    expect(screen.queryByText(/Claude Code/)).not.toBeInTheDocument();
  });

  it('uses a neutral fallback label when the model name is missing', () => {
    renderSeparator(undefined);

    expect(screen.getByText('AI model')).toBeInTheDocument();
  });
});

describe('TurnSeparator identity mark', () => {
  /**
   * A hosted agent has a real identity subject, so it draws the resolver's
   * avatar — the user-configured image if there is one, its monogram if not.
   */
  it('draws a resolved agent avatar for a turn a vendor owns', () => {
    const parts: MessagePart[] = [
      {
        type: 'external_turn',
        version: 1,
        targetId: 'claude',
        sessionId: 's1',
        status: 'terminal',
        startedAt: 0,
        updatedAt: 0,
        lastSequence: 0,
        eventCount: 0,
        persistedBytes: 0,
      },
    ];

    const { container } = renderSeparator('claude', parts);

    expect(container.querySelector('[data-tool-avatar]')).not.toBeNull();
    expect(screen.getByText(/Claude Code/i)).toBeInTheDocument();
  });

  /**
   * A model is not a subject: `ToolIdentityKind` has no `model` member and
   * `parseSubjectKey` validates the id against its kind, so a `model:` subject
   * key would be one the API rejects and no user could edit. It gets a plain
   * monogram chip instead.
   */
  it('draws a plain monogram chip for a turn no vendor owns', () => {
    const { container } = renderSeparator('gpt-5-codex');

    expect(container.querySelector('[data-tool-avatar]')).toBeNull();
    // `deriveMonogram('gpt-5-codex')` — one word, so its first two characters.
    expect(screen.getByText('GP')).toBeInTheDocument();
  });
});

/**
 * The chip yields to the working row, which only exists on the timeline. An
 * image turn has no timeline: `AssistantTurnBody` swaps the whole thing for
 * the generating placeholder, so the row the chip defers to is never drawn and
 * deferring left the separator saying nothing at all.
 */
describe('TurnSeparator status while an image generates', () => {
  it('names the phase for an image turn, which draws no working row to yield to', () => {
    const msg = createMockMessage({ role: 'ai', modelName: 'gpt-image-2', isGenerating: true });
    const status = deriveTurnStatus([], true);

    expect(status.showWorkingRow).toBe(true);
    render(<TurnSeparator msg={msg} parts={[]} status={status} isImageTurn />);

    expect(screen.getByText('Working')).toBeInTheDocument();
  });

  it('still yields to the row a text turn does draw', () => {
    const msg = createMockMessage({ role: 'ai', modelName: 'gpt-5.2', isGenerating: true });

    render(
      <TurnSeparator msg={msg} parts={[]} status={deriveTurnStatus([], true)} isImageTurn={false} />
    );

    expect(screen.queryByText('Working')).not.toBeInTheDocument();
  });
});
