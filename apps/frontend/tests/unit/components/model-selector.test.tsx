/**
 * A chat is tied to the provider of its first model. The menu keeps the other
 * providers' models in view, as locked rows — and a locked row is information,
 * not decoration: its name is not faded, and one line says why it is out of
 * reach.
 */

import { describe, expect, it } from 'bun:test';

import type { ModelOption } from '@mangostudio/shared/catalog';
import { en } from '@mangostudio/shared/i18n';
import { fireEvent, screen, within } from '@testing-library/react';

import { ModelSelector } from '../../../src/components/layout/ModelSelector';
import { EMPTY_MODEL_CATALOG } from '../../../src/utils/model-utils';
import { render } from '../../support/harness/render';

function model(modelId: string, displayName: string, provider: ModelOption['provider']) {
  return { modelId, displayName, resourceName: modelId, supportedActions: ['text'], provider };
}

const MODELS: ModelOption[] = [
  {
    ...model('gemini-pro', 'Gemini Pro', 'gemini'),
    capabilities: { text: true, image: false, streaming: true, reasoning: true },
  },
  model('deepseek-chat', 'DeepSeek Chat', 'deepseek'),
  model('deepseek-v4-pro', 'DeepSeek V4 Pro', 'deepseek'),
  model('claude-sonnet', 'Claude Sonnet', 'anthropic'),
];

function open(lockedProvider: ModelOption['provider'] | null) {
  render(
    <ModelSelector
      activeModel="gemini-pro"
      activeModels={MODELS}
      isDisabled={false}
      onSelect={() => undefined}
      modelCatalog={EMPTY_MODEL_CATALOG}
      lockedProvider={lockedProvider}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: en.chat.input.modelLabel }));
}

describe('model selector locked rows', () => {
  it('keeps a locked name readable: stepped down a colour, not faded', () => {
    open('gemini');

    const locked = screen.getByRole('button', { name: /DeepSeek Chat/ });
    expect(locked).toBeDisabled();
    expect(locked.className).toContain('cursor-not-allowed');
    expect(locked.className).not.toContain('opacity');

    const name = screen.getByText('DeepSeek Chat');
    expect(name.className).toContain('text-fg-muted');
    expect(name.className).not.toMatch(/(^|\s)text-fg(\s|$)/);
    // An open row keeps the primary colour.
    const usable = screen.getByRole('button', { name: /Gemini Pro/ });
    expect(usable.querySelector('.truncate')?.className).toMatch(/(^|\s)text-fg(\s|$)/);
  });

  it('says once, for the whole list, which provider the chat is tied to', () => {
    open('gemini');

    const reason = en.models.providerLocked.replace('{provider}', en.providers.gemini);
    // Three locked models across two providers, one sentence.
    expect(screen.getAllByText(reason)).toHaveLength(1);
  });

  it('says nothing when no row is locked', () => {
    open(null);
    expect(screen.queryByText(/Start a new chat to use another provider/)).toBeNull();
  });
});

describe('model selector rows', () => {
  // A badge on its own line made every reasoning model 22px taller than its
  // neighbours, and the list ragged (3 of 5 rows in the new-chat menu).
  it('keeps every row one 32px line, with the badge beside the name', () => {
    open(null);

    const reasoning = screen.getByRole('button', { name: /Gemini Pro/ });
    const plain = screen.getByRole('button', { name: /DeepSeek Chat/ });
    for (const row of [reasoning, plain]) expect(row.className).toContain('h-8');

    const badge = within(reasoning).getByText(en.thinking.reasoningBadge);
    // Same row, after the name and before the check.
    expect(reasoning.contains(badge)).toBe(true);
    const name = reasoning.querySelector('.truncate') as HTMLElement;
    expect(name.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(badge.parentElement).toBe(reasoning);
  });

  it('is a popup of buttons and does not promise a listbox it does not keep', () => {
    open(null);

    const trigger = screen.getByRole('button', { name: en.chat.input.modelLabel });
    expect(trigger).toHaveAttribute('aria-haspopup', 'true');
  });
});
