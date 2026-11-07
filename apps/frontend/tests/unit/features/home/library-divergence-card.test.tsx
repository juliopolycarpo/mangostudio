import { afterEach, describe, expect, it } from 'bun:test';

import { LibraryDivergenceCard } from '../../../../src/features/home/widgets/LibraryDivergenceCard';
import { screen } from '../../../support/harness/render';
import { renderWithRouter } from '../../../support/harness/render-with-router';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';
import { fullCoverage, instance, resource } from '../library/fixtures';

const scenario = createFetchScenario();

afterEach(() => scenario.restore());

describe('LibraryDivergenceCard', () => {
  it('describes conflicting copies inside one target during an incomplete scan', async () => {
    const skill = resource({
      instances: [
        instance({ locationId: 'cursor-skills', contentHash: 'user-copy' }),
        instance({ locationId: 'cursor-skills-builtin', contentHash: 'built-in-copy' }),
      ],
      coverage: fullCoverage({
        claude: { unscannedLocationIds: ['claude-skills'] },
        mangostudio: { unscannedLocationIds: ['claude-skills'] },
        cursor: {
          state: 'shadowed',
          effectiveLocationId: 'cursor-skills',
          shadowedLocationIds: ['cursor-skills-builtin'],
        },
      }),
      divergence: 'divergent',
    });
    scenario
      .respondWithJson('GET', '/api/library/resources?kind=skill', {
        body: { resources: [skill], unreadableEntries: [] },
      })
      .install();

    await renderWithRouter(<LibraryDivergenceCard environmentId={null} kind="skill" />);

    const description = await screen.findByText(/this skill/);
    expect(description.textContent).toBe('Different copies of this skill in Cursor.');
  });
});
