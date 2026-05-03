/**
 * Integration tests for the Studio placeholder route.
 */
import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../support/harness/render';
import { StudioPage } from '../../../src/routes/_authenticated/studio';

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual('@tanstack/react-router');
  return {
    ...actual,
    Link: ({
      to,
      children,
      ...props
    }: {
      to: string;
      children: React.ReactNode;
      [key: string]: unknown;
    }) => (
      <a href={to} {...props}>
        {children}
      </a>
    ),
  };
});

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
