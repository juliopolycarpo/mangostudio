import { afterEach, describe, expect, it } from 'vitest';
import { ChatGptPromoChip } from '@/features/settings/connectors/components/ChatGptPromoChip';
import { fireEvent, render, screen } from '../../support/harness/render';

afterEach(() => {
  window.localStorage.clear();
});

describe('ChatGptPromoChip', () => {
  it('shows the promo and hides it after dismissal, persisting per connector', () => {
    render(<ChatGptPromoChip connectorId="connector-1" message="Try the new plan!" />);
    expect(screen.getByText('Try the new plan!')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Dismiss announcement'));
    expect(screen.queryByText('Try the new plan!')).not.toBeInTheDocument();
    expect(window.localStorage.getItem('mango.chatgpt-promo-dismissed:connector-1')).toBe(
      'Try the new plan!'
    );
  });

  it('stays hidden for a dismissed message but shows a new one', () => {
    window.localStorage.setItem('mango.chatgpt-promo-dismissed:connector-1', 'Old promo');

    const { unmount } = render(<ChatGptPromoChip connectorId="connector-1" message="Old promo" />);
    expect(screen.queryByText('Old promo')).not.toBeInTheDocument();
    unmount();

    render(<ChatGptPromoChip connectorId="connector-1" message="New promo" />);
    expect(screen.getByText('New promo')).toBeInTheDocument();
  });
});
