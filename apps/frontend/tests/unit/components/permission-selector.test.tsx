/**
 * The permission control renders the combinations the adapter vetted, and only
 * those. Two free controls composing a pair no vendor offers is the failure this
 * shape exists to prevent, so the tests are written against that.
 */

import { describe, expect, it, jest } from 'bun:test';
import type { ExternalSupportedConfiguration } from '@mangostudio/shared/external-agents';
import { fireEvent, screen } from '@testing-library/react';
import { PermissionSelector } from '../../../src/features/chat/components/PermissionSelector';
import { render } from '../../support/harness/render';

function open(
  configurations: readonly ExternalSupportedConfiguration[],
  overrides: Partial<React.ComponentProps<typeof PermissionSelector>> = {}
) {
  const props = {
    configurations,
    level: 'default' as const,
    routing: 'user' as const,
    onChange: jest.fn(),
    ...overrides,
  };
  const result = render(<PermissionSelector {...props} />);
  fireEvent.click(screen.getByRole('button', { name: /permissions/i }));
  return { ...result, props };
}

const FULL_MATRIX: ExternalSupportedConfiguration[] = [
  { level: 'read-only', routing: 'user', supported: true, unattended: false },
  { level: 'default', routing: 'user', supported: true, unattended: false },
  { level: 'full-access', routing: 'user', supported: true, unattended: true },
  { level: 'default', routing: 'auto-review', supported: true, unattended: true },
];

describe('permission selector', () => {
  it('renders only the levels and routings the adapter returned', () => {
    open([
      { level: 'read-only', routing: 'user', supported: true, unattended: false },
      { level: 'default', routing: 'user', supported: true, unattended: false },
    ]);
    expect(screen.getByRole('button', { name: /Read only/ })).toBeInTheDocument();
    // `full-access` appears in no returned pair, so it is not a choice this
    // vendor has, so it is not a control.
    expect(screen.queryByRole('button', { name: /Allow everything/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Auto-review/ })).toBeNull();
  });

  it('renders nothing at all when the adapter returned no combinations', () => {
    render(
      <PermissionSelector
        configurations={[]}
        level="read-only"
        routing="user"
        onChange={jest.fn()}
      />
    );
    expect(screen.queryByRole('button', { name: /permissions/i })).toBeNull();
  });

  it('disables an unsupported pair and shows it as a policy refusal', () => {
    open([
      { level: 'default', routing: 'user', supported: true, unattended: false },
      {
        level: 'full-access',
        routing: 'user',
        supported: false,
        unattended: true,
        unsupportedReasonKey: 'externalAgents.unsupported.codexProfileDisallowed',
      },
    ]);
    const fullAccess = screen.getByRole('button', { name: /Allow everything/ });
    expect(fullAccess).toBeDisabled();
    // The user is looking at something their machine's config decided, not at a
    // MangoStudio limitation.
    expect(screen.getByText(/does not allow that profile/i)).toBeInTheDocument();
  });

  it('falls back to a generic refusal for a reason key it does not know', () => {
    open([
      { level: 'default', routing: 'user', supported: true, unattended: false },
      {
        level: 'full-access',
        routing: 'user',
        supported: false,
        unattended: true,
        unsupportedReasonKey: 'externalAgents.unsupported.somethingNewer',
      },
    ]);
    expect(screen.getByText(/does not offer this combination/i)).toBeInTheDocument();
  });

  it('warns on full access and on auto-review, and nowhere else', () => {
    open(FULL_MATRIX);
    expect(screen.getByText(/can edit and run anything/i)).toBeInTheDocument();
    expect(screen.getByText(/answered without you/i)).toBeInTheDocument();
    expect(screen.queryAllByText(/can edit and run anything/i)).toHaveLength(1);
  });

  it('moves the other axis to something composable rather than to an unsupported pair', () => {
    const { props } = open([
      { level: 'read-only', routing: 'user', supported: true, unattended: false },
      { level: 'full-access', routing: 'auto-review', supported: true, unattended: true },
      { level: 'full-access', routing: 'user', supported: false, unattended: true },
    ]);
    fireEvent.click(screen.getByRole('button', { name: /Allow everything/ }));
    expect(props.onChange).toHaveBeenCalledWith({
      level: 'full-access',
      routing: 'auto-review',
    });
  });

  it('marks the pair the chat is actually on', () => {
    open(FULL_MATRIX, { level: 'full-access', routing: 'user' });
    expect(screen.getByRole('button', { name: /Allow everything/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByRole('button', { name: /Read only/ })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });
});
