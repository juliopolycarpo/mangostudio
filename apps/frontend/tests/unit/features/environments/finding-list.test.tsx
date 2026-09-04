/**
 * FindingList: a `remedy` param that is itself a URL renders as a link a
 * person can follow, not as inert text buried in the sentence.
 */

import { describe, expect, it } from 'bun:test';
import type { RuntimeFinding } from '@mangostudio/shared/environments';
import { FindingList } from '../../../../src/features/environments/components/FindingList';
import { render, screen } from '../../../support/harness/render';

describe('FindingList', () => {
  it('renders a URL remedy as a link, separate from the sentence around it', () => {
    const remedy = 'https://apps.microsoft.com/detail/9nblggh4nns1';
    const finding: RuntimeFinding = {
      code: 'prerequisite-missing',
      params: { recipe: 'Install Node', requirement: 'winget', remedy },
    };

    render(<FindingList findings={[finding]} />);

    const link = screen.getByTestId('finding-remedy-link');
    expect(link).toHaveAttribute('href', remedy);
    expect(link.textContent).toBe(remedy);
    // The link text is not duplicated inside the sentence around it. Counted by
    // splitting rather than matching: an unanchored URL pattern is the shape
    // CodeQL flags, and nothing here needs a regular expression.
    const item = screen.getByTestId('finding-list').textContent ?? '';
    expect(item.split(remedy).length - 1).toBe(1);
  });

  it('renders a non-URL remedy as plain text, with no link', () => {
    const finding: RuntimeFinding = {
      code: 'prerequisite-missing',
      params: {
        recipe: 'Install Node',
        requirement: 'nvm',
        remedy: 'Install it yourself, then re-check.',
      },
    };

    render(<FindingList findings={[finding]} />);

    expect(screen.queryByTestId('finding-remedy-link')).not.toBeInTheDocument();
    expect(screen.getByTestId('finding-list').textContent).toContain(
      'Install it yourself, then re-check.'
    );
  });
});
