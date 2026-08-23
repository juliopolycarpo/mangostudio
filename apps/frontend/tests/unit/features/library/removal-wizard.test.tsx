/**
 * The removal wizard after the server refuses an apply.
 *
 * A 409 means the preview the draft was built against no longer describes the
 * disk. Pressing Remove again can only reproduce the refusal, so the button has
 * to go out of reach until a fresh preview arrives.
 */

import { afterEach, describe, expect, it, jest } from 'bun:test';
import { en } from '@mangostudio/shared/i18n';
import type { RemovalPreview } from '@mangostudio/shared/library';
import userEvent from '@testing-library/user-event';
import { RemovalWizard } from '../../../../src/features/library/components/RemovalWizard';
import { screen } from '../../../support/harness/render';
import { renderWithRouter } from '../../../support/harness/render-with-router';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';

const preview: RemovalPreview = {
  previewToken: 'token',
  stateHash: 'state',
  entries: [
    {
      resourceKey: 'skill:gh',
      ref: { kind: 'skill', slug: 'gh' },
      divergence: 'uniform',
      locations: [
        {
          environmentId: 'local',
          locationId: 'claude-skills',
          targetIds: [],
          operation: 'remove',
          path: '/home/dev/.claude/skills/gh',
          contentHash: 'a3f9c1',
          modifiedAtMs: 1_700_000_000_000,
          eliminatesContentGroup: false,
        },
      ],
      instancePlacements: [
        { environmentId: 'local', locationId: 'claude-skills' },
        { environmentId: 'local', locationId: 'agents-skills' },
      ],
      wouldRemoveLastCopy: false,
    },
  ],
  staleStagedRemovals: [],
};

const scenario = createFetchScenario()
  .respondWithJson('GET', '/api/environments', { body: [] })
  .respondWithJson('POST', '/api/library/removal/preview', { body: preview })
  .respondWithJson('POST', '/api/library/removal/apply', {
    status: 409,
    body: { error: 'The library changed since this preview was taken.', code: 'VALIDATION' },
  });

afterEach(() => {
  scenario.restore();
});

describe('RemovalWizard after a stale rejection', () => {
  it('puts Remove out of reach until a fresh preview arrives', async () => {
    scenario.install();
    const user = userEvent.setup();

    await renderWithRouter(
      <RemovalWizard
        resourceKeys={['skill:gh']}
        locationIds={['claude-skills']}
        onClose={() => undefined}
      />
    );

    await user.click(await screen.findByTestId('removal-row'));
    await user.click(screen.getByTestId('continue-button'));

    const remove = screen.getByTestId('remove-button');
    expect(remove).toBeEnabled();
    await user.click(remove);

    expect(await screen.findByText(en.library.removal.stale)).toBeInTheDocument();
    // Clicking again would send the same draft against the same refused
    // preview; "Preview again" beside the banner is the only way on.
    expect(screen.getByTestId('remove-button')).toBeDisabled();
  });
});

describe('RemovalWizard while the environment scope is still loading', () => {
  it('does not preview against a partial machine scope', async () => {
    let resolveEnvironments!: () => void;
    const pendingEnvironments = new Promise<Response>((resolve) => {
      resolveEnvironments = () =>
        resolve(
          new Response(JSON.stringify([]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        );
    });
    const fetchMock = jest.fn((input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
      if (url.pathname === '/api/environments') return pendingEnvironments;
      if (url.pathname === '/api/library/removal/preview') {
        return Promise.resolve(
          new Response(JSON.stringify(preview), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        );
      }
      return Promise.reject(new Error(`[test] Unhandled request: ${url.pathname}`));
    });
    // `vi.stubGlobal` has no Bun equivalent. `bun.setup.ts` reinstates its
    // unreachable `fetch` after every test, so a plain assignment cannot leak.
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await renderWithRouter(
      <RemovalWizard
        resourceKeys={['skill:gh']}
        locationIds={['claude-skills']}
        onClose={() => undefined}
      />
    );

    // The environment scope is still one machine wide; a preview taken now
    // would miss every other enabled machine's copies.
    expect(await screen.findByTestId('library-loading')).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).includes('/library/removal/preview'))
    ).toEqual([]);

    resolveEnvironments();

    await screen.findByTestId('removal-row');
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).includes('/library/removal/preview'))
    ).not.toEqual([]);
  });
});
