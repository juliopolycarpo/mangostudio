/**
 * Integration tests for the Studio placeholder route.
 */

import { describe, expect, it, mock } from 'bun:test';
import { screen } from '@testing-library/react';
import { render } from '../../support/harness/render';
import { LinkStub } from '../../support/mocks/router';

// The `bun test` shape of vitest's `vi.mock(…, async () => ({ ...await
// vi.importActual(…) }))`: the real namespace is imported first, spread into
// the replacement, and the module under test is imported afterwards so it binds
// to the mock rather than to the original.
//
// `mock.module` mutates a module graph that `bun test` shares across files and
// survives `mock.restore()`, so this lane runs under `--isolate`. Without it,
// every later file in the run would get this `Link` too.
const actual = await import('@tanstack/react-router');

mock.module('@tanstack/react-router', () => ({ ...actual, Link: LinkStub }));

const { StudioPage } = await import('../../../src/routes/_authenticated/studio');

describe('Studio Route — Integration', () => {
  it('renders the studio title', () => {
    render(<StudioPage />);
    expect(screen.getByRole('heading', { name: 'Studio' })).toBeInTheDocument();
  });

  it('renders the coming-soon message', () => {
    render(<StudioPage />);
    expect(screen.getByText(/coming soon/i)).toBeInTheDocument();
  });
});
