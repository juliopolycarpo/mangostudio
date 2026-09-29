/**
 * The boundary that stands in for the application when a bootstrap request is
 * refused. What it must do is name the class of failure and offer the retry —
 * the router's default names neither, and is not translatable.
 */

import { describe, expect, it } from 'bun:test';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import { en } from '@mangostudio/shared/i18n';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import {
  BootstrapErrorPanel,
  errorDetail,
} from '../../../src/components/layout/BootstrapErrorPanel';
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

  it('keeps a thrown string as the detail, since a loader may throw any value', async () => {
    await renderWithRouter(<BootstrapErrorPanel error="gateway closed" />);

    expect(screen.getByRole('alert')).toHaveTextContent(/gateway closed/);
  });
});

describe('BootstrapErrorPanel inside the shell', () => {
  it('stands over the whole surface unless told otherwise', async () => {
    await renderWithRouter(<BootstrapErrorPanel error={new Error('refused')} />);

    expect(screen.getByRole('alert').parentElement).toHaveAttribute('data-placement', 'surface');
    expect(screen.queryByTestId('bootstrap-error-failed')).toBeNull();
  });

  it('names every responsibility that did not load, in one sentence', async () => {
    await renderWithRouter(
      <BootstrapErrorPanel
        error={new Error('refused')}
        placement="content"
        failed={['chats', 'agents']}
      />
    );

    const { failed, responsibilities } = en.errors.bootstrap;
    expect(screen.getByRole('alert').parentElement).toHaveAttribute('data-placement', 'content');
    expect(screen.getByTestId('bootstrap-error-failed')).toHaveTextContent(
      failed.replace('{items}', `${responsibilities.chats} and ${responsibilities.agents}`)
    );
  });

  it('runs the retry it was given instead of re-running the route', async () => {
    let retries = 0;
    const { router } = await renderWithRouter(
      <BootstrapErrorPanel
        error={new Error('refused')}
        placement="content"
        failed={['catalog']}
        onRetry={() => {
          retries += 1;
          return Promise.resolve();
        }}
      />
    );
    let invalidations = 0;
    router.invalidate = () => {
      invalidations += 1;
      return Promise.resolve();
    };

    fireEvent.click(screen.getByTestId('bootstrap-error-retry'));

    await waitFor(() => expect(retries).toBe(1));
    expect(
      invalidations,
      `expected route re-runs from a scoped retry: 0 | received: ${invalidations}`
    ).toBe(0);
  });
});

describe('errorDetail', () => {
  it('reads the message from an Error, a string as-is, and nothing from other values', () => {
    expect(errorDetail(new Error('socket hang up'))).toBe('socket hang up');
    expect(errorDetail('gateway closed')).toBe('gateway closed');
    expect(errorDetail({ status: 503 })).toBe('');
    expect(errorDetail(undefined)).toBe('');
  });
});
