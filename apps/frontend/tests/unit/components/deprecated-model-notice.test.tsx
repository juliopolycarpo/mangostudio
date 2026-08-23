import { describe, expect, it, jest } from 'bun:test';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DeprecatedModelNotice } from '@/features/chat/components/DeprecatedModelNotice';
import { render } from '../../support/harness/render';

const DETAILS = {
  reason: 'provider-deprecated' as const,
  action: 'fork-with-external-runner' as const,
  modelId: 'cursor/composer-2.5',
  provider: 'cursor' as const,
  targetId: 'cursor' as const,
};

describe('DeprecatedModelNotice', () => {
  it('offers the fork when the vendor CLI can start a turn', async () => {
    const user = userEvent.setup();
    const onContinueWithRunner = jest.fn();

    render(
      <DeprecatedModelNotice
        details={DETAILS}
        isForking={false}
        runnerAvailable
        onContinueWithRunner={onContinueWithRunner}
        onDismiss={jest.fn()}
      />
    );

    await user.click(screen.getByRole('button', { name: /continue in a new chat/i }));
    expect(onContinueWithRunner).toHaveBeenCalledWith('cursor');
  });

  it('hides the fork when the vendor CLI cannot start a turn', () => {
    render(
      <DeprecatedModelNotice
        details={DETAILS}
        isForking={false}
        runnerAvailable={false}
        onContinueWithRunner={jest.fn()}
        onDismiss={jest.fn()}
      />
    );

    expect(
      screen.queryByRole('button', { name: /continue in a new chat/i })
    ).not.toBeInTheDocument();
    expect(screen.getByText(/not available in this environment/i)).toBeInTheDocument();
  });
});
