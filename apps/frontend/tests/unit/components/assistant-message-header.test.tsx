/**
 * What the assistant turn header calls the thing that produced the turn.
 *
 * An external turn stores `configuration.model ?? targetId`, so the bare vendor
 * id reaches this header whenever the vendor resolved no model — and a vendor id
 * is a wire value, not a name the user should be shown.
 */

import { createMockMessage } from '@mangostudio/shared/test-utils';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AssistantMessageHeader } from '../../../src/features/chat/components/AssistantMessageHeader';
import { render } from '../../support/harness/render';

function renderHeader(modelName: string | undefined) {
  render(
    <AssistantMessageHeader
      msg={createMockMessage({ role: 'ai', modelName, isGenerating: false })}
      isImageTurn={false}
    />
  );
}

describe('AssistantMessageHeader model name', () => {
  it('names a vendor by its label, not its target id', () => {
    renderHeader('codex');

    expect(screen.getByText(/Codex CLI/i)).toBeInTheDocument();
    expect(screen.queryByText(/\bcodex replied\b/)).not.toBeInTheDocument();
  });

  // A vendor model id is already a name the user recognises, and it is not
  // ours to translate.
  it('leaves a model id alone', () => {
    renderHeader('gpt-5-codex');

    expect(screen.getByText(/gpt-5-codex/i)).toBeInTheDocument();
  });

  // Exact match only: `claude` is a target id, `claude-opus-4` is a model that
  // merely starts with one.
  it('does not mistake a model that begins with a target id for the vendor', () => {
    renderHeader('claude-opus-4');

    expect(screen.getByText(/claude-opus-4/i)).toBeInTheDocument();
    expect(screen.queryByText(/Claude Code/)).not.toBeInTheDocument();
  });
});
