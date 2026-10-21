import { describe, expect, it, jest } from 'bun:test';
import { ToastProvider, useToast } from '@/components/ui/Toast';
import { act, fireEvent, render, screen } from '../../../support/harness/render';
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

  describe('announcement', () => {
    it('sits in a labelled polite live region, so an arriving toast is not silent', () => {
      render(
        <ToastProvider>
          <ToastTester />
        </ToastProvider>
      );

      act(() => {
        screen.getByText('Show Success').click();
      });

      // The test harness mounts its own provider too, so the region is found
      // from the toast rather than by role alone.
      const region = screen.getByText('Operation successful').closest('[aria-live]');
      expect(region).toHaveAttribute('aria-live', 'polite');
      expect(region).toHaveAccessibleName('Notifications');
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('marks an error toast as an alert', () => {
      render(
        <ToastProvider>
          <ToastTester />
        </ToastProvider>
      );

      act(() => {
        screen.getByText('Show Error').click();
      });

      expect(screen.getByRole('alert')).toHaveTextContent('Something failed');
    });
  });

  describe('auto-dismiss timers', () => {
    it('holds the clock while the pointer is over a toast and resumes with what was left', async () => {
      useFakeTimers();
      render(
        <ToastProvider>
          <ToastTester />
        </ToastProvider>
      );

      act(() => {
        screen.getByText('Show Error').click();
      });
      const card = screen.getByRole('alert');

      await advanceTimersByTimeAsync(3000);
      fireEvent.mouseEnter(card);
      // Far past the 4s the toast would otherwise have had.
      await advanceTimersByTimeAsync(20_000);
      expect(screen.getByText('Something failed')).toBeInTheDocument();

      fireEvent.mouseLeave(card);
      await advanceTimersByTimeAsync(999);
      expect(screen.getByText('Something failed')).toBeInTheDocument();
      await advanceTimersByTimeAsync(1);
      expect(screen.queryByText('Something failed')).not.toBeInTheDocument();
    });

    it('holds the clock while focus is inside a toast', async () => {
      useFakeTimers();
      render(
        <ToastProvider>
          <ToastTester />
        </ToastProvider>
      );

      act(() => {
        screen.getByText('Show Success').click();
      });
      const dismiss = screen.getByRole('button', { name: 'Dismiss toast' });

      act(() => {
        dismiss.focus();
      });
      await advanceTimersByTimeAsync(20_000);
      expect(screen.getByText('Operation successful')).toBeInTheDocument();

      act(() => {
        dismiss.blur();
      });
      await advanceTimersByTimeAsync(4000);
      expect(screen.queryByText('Operation successful')).not.toBeInTheDocument();
    });

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
