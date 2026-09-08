/**
 * The boundary that stands in for the application when a bootstrap request is
 * refused. What it must do is name the class of failure and offer the retry —
 * the router's default names neither, and is not translatable.
 */

import { describe, expect, it } from 'bun:test';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import { screen } from '@testing-library/react';
import { BootstrapErrorPanel } from '../../../src/components/layout/BootstrapErrorPanel';
import { ApiError } from '../../../src/lib/utils';
import { renderWithRouter } from '../../support/harness/render-with-router';

describe('BootstrapErrorPanel', () => {
  it('names a rate limit rather than repeating the raw sentence as the headline', async () => {
    await renderWithRouter(
      <BootstrapErrorPanel
        error={new ApiError({ error: 'Too many requests', code: ERROR_CODES.RATE_LIMITED })}
      />
    );

    expect(screen.getByRole('alert')).toHaveTextContent(/Too many requests came from this address/);
    expect(screen.getByTestId('bootstrap-error-retry')).toBeInTheDocument();
  });

  it('falls back to the generic sentence for any other failure, keeping the detail beneath', async () => {
    await renderWithRouter(<BootstrapErrorPanel error={new Error('socket hang up')} />);

    expect(screen.getByRole('alert')).toHaveTextContent(/every page depends on was refused/);
    expect(screen.getByRole('alert')).toHaveTextContent(/socket hang up/);
  });
});
