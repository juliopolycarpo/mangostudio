/**
 * PrerequisiteCard: winget's compact card — a name, a health badge, whether
 * it is there, and its findings. No install action, because MangoStudio has
 * no recipe that would ever put one on this card.
 */

import { describe, expect, it } from 'bun:test';
import { en } from '@mangostudio/shared/i18n';
import { PrerequisiteCard } from '../../../../src/features/environments/components/PrerequisiteCard';
import { render, screen } from '../../../support/harness/render';
import { installation, runtimeStatus } from './fixtures';

describe('PrerequisiteCard', () => {
  it('names the hint and offers no install action, even when missing', () => {
    const status = runtimeStatus({ id: 'winget', health: 'missing', installations: [] });

    render(<PrerequisiteCard status={status} />);

    expect(screen.getByText(en.environments.runtimes.prerequisiteHint)).toBeInTheDocument();
    expect(screen.getByText('winget is not installed yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /install/i })).not.toBeInTheDocument();
  });

  it('shows the effective version once winget answers', () => {
    const status = runtimeStatus({
      id: 'winget',
      installations: [installation({ path: 'winget', version: '1.9.25200', effective: true })],
    });

    render(<PrerequisiteCard status={status} />);

    expect(screen.getByText('1.9.25200')).toBeInTheDocument();
  });
});
