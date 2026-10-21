/**
 * SettingsComparison: the cards are sized by how many there are, and an agent
 * with nothing to compare is one line, not a card that repeats the state.
 *
 * A fixed four columns left an empty one at the end of every row (three agents
 * read settings), and most of what was on screen was the words "Not configured"
 * in a bordered card, about six times over.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { en } from '@mangostudio/shared/i18n';
import type { ConceptComparison } from '@mangostudio/shared/library';
import { SettingsComparison } from '../../../../src/features/library/components/SettingsComparison';
import { screen, within } from '../../../support/harness/render';
import { renderWithRouter } from '../../../support/harness/render-with-router';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';

const COMPARISON: ConceptComparison[] = [
  {
    concept: 'selected-model',
    comparability: 'rough',
    entries: [
      {
        targetId: 'claude',
        state: 'detected',
        fields: [{ path: 'model', presentation: 'value', value: 'opus' }],
      },
      { targetId: 'codex', state: 'not-detected', fields: [] },
      { targetId: 'cursor', state: 'not-detected', fields: [] },
    ],
  },
  {
    concept: 'allow-list',
    comparability: 'rough',
    entries: [
      { targetId: 'claude', state: 'not-detected', fields: [] },
      { targetId: 'codex', state: 'not-detected', fields: [] },
      { targetId: 'cursor', state: 'not-applicable', fields: [] },
    ],
  },
] as ConceptComparison[];

/** Restoring a scenario forgets its answers, so each test registers its own. */
let scenario = createFetchScenario();

function installScenario() {
  scenario = createFetchScenario()
    .respondWithJson('GET', '/api/environments', { body: [] })
    .respondWithJson('GET', '/api/library/settings/compare', { body: COMPARISON })
    .respondWithJson('GET', '/api/library/settings', { body: [] })
    .respondWithJson('GET', '/api/library/locations', { body: [] })
    .install();
}

afterEach(() => {
  scenario.restore();
});

describe('SettingsComparison', () => {
  it('gives the agents that have something one card each, and the rest one line', async () => {
    installScenario();
    await renderWithRouter(<SettingsComparison />);

    const sections = await screen.findAllByTestId('concept-section');
    const model = sections.find((section) => section.dataset.concept === 'selected-model');
    if (!model) throw new Error('expected the selected-model section');

    expect(within(model).getAllByTestId('concept-entry')).toHaveLength(1);
    expect(within(model).getByTestId('concept-quiet')).toHaveTextContent(
      en.library.settings.undetectedLine['not-detected'].replace('{agents}', 'Codex and Cursor')
    );
  });

  it('draws a concept nobody configured as lines only, one per state', async () => {
    installScenario();
    await renderWithRouter(<SettingsComparison />);

    const sections = await screen.findAllByTestId('concept-section');
    const allow = sections.find((section) => section.dataset.concept === 'allow-list');
    if (!allow) throw new Error('expected the allow-list section');

    expect(within(allow).queryByTestId('concept-entry')).not.toBeInTheDocument();
    const lines = within(allow).getAllByTestId('concept-quiet');
    expect(lines.map((line) => line.dataset.state)).toEqual(['not-detected', 'not-applicable']);
    expect(lines[0]).toHaveTextContent('Claude Code and Codex');
    expect(lines[1]).toHaveTextContent(
      en.library.settings.undetectedLine['not-applicable'].replace('{agents}', 'Cursor')
    );
  });

  it('shares the width between however many cards there are', async () => {
    installScenario();
    await renderWithRouter(<SettingsComparison />);

    const [section] = await screen.findAllByTestId('concept-section');
    const grid = within(section).getAllByTestId('concept-entry')[0].parentElement as HTMLElement;
    expect(grid.className).toContain('auto-fit');
    expect(grid.className).not.toContain('lg:grid-cols-4');
  });
});
