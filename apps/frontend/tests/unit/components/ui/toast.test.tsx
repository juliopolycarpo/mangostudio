import { describe, expect, it, jest } from 'bun:test';
import { ToastProvider, useToast } from '@/components/ui/Toast';
import { act, render, screen } from '../../../support/harness/render';
import { advanceTimersByTimeAsync, useFakeTimers } from '../../../support/harness/timers';

function ToastTester() {
  const { toast } = useToast();

  return (
    <div>
      <button type="button" onClick={() => toast('Operation successful', 'success')}>
        Show Success
      </button>
      <button type="button" onClick={() => toast('Something failed', 'error')}>
        Show Error
      </button>
      <button type="button" onClick={() => toast('Just info')}>
        Show Info
      </button>
    </div>
  );
}

describe('ToastProvider + useToast', () => {
  it('shows a toast message when toast is called', () => {
    render(
      <ToastProvider>
        <ToastTester />
      </ToastProvider>
    );

    act(() => {
      screen.getByText('Show Success').click();
    });

    expect(screen.getByText('Operation successful')).toBeInTheDocument();
  });

  it('shows an info toast with default type', () => {
    render(
      <ToastProvider>
        <ToastTester />
      </ToastProvider>
    );

    act(() => {
      screen.getByText('Show Info').click();
    });

    expect(screen.getByText('Just info')).toBeInTheDocument();
  });

  it('shows an error toast', () => {
    render(
      <ToastProvider>
        <ToastTester />
      </ToastProvider>
    );

    act(() => {
      screen.getByText('Show Error').click();
    });

    expect(screen.getByText('Something failed')).toBeInTheDocument();
  });

  describe('auto-dismiss timers', () => {
    it('drops the toast once the auto-dismiss delay elapses', async () => {
      useFakeTimers();
      render(
        <ToastProvider>
          <ToastTester />
        </ToastProvider>
      );

      act(() => {
        screen.getByText('Show Success').click();
      });
      expect(screen.getByText('Operation successful')).toBeInTheDocument();

      // No outer `act`: the harness advance wraps the clock move in one itself.
      await advanceTimersByTimeAsync(4000);

      expect(screen.queryByText('Operation successful')).not.toBeInTheDocument();
    });

    // A pending timer outlives its provider by up to 4s. Left uncleared it wakes
    // up inside a torn-down environment and takes the whole suite down with
    // "ReferenceError: window is not defined" from React's scheduler.
    it('clears pending timers on unmount', () => {
      useFakeTimers();
      const { unmount } = render(
        <ToastProvider>
          <ToastTester />
        </ToastProvider>
      );

      act(() => {
        screen.getByText('Show Success').click();
      });
      expect(jest.getTimerCount()).toBeGreaterThan(0);

      unmount();

      expect(jest.getTimerCount()).toBe(0);
    });

    it('clears the pending timer when a toast is dismissed by hand', () => {
      useFakeTimers();
      render(
        <ToastProvider>
          <ToastTester />
        </ToastProvider>
      );

      act(() => {
        screen.getByText('Show Success').click();
      });

      act(() => {
        screen.getByRole('button', { name: 'Dismiss toast' }).click();
      });

      expect(screen.queryByText('Operation successful')).not.toBeInTheDocument();
      expect(jest.getTimerCount()).toBe(0);
    });
  });
});
