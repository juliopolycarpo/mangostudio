import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, useToast } from '@/components/ui/Toast';
import { act, render, screen } from '../../../support/harness/render';

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
    afterEach(() => {
      vi.useRealTimers();
    });

    it('drops the toast once the auto-dismiss delay elapses', () => {
      vi.useFakeTimers();
      render(
        <ToastProvider>
          <ToastTester />
        </ToastProvider>
      );

      act(() => {
        screen.getByText('Show Success').click();
      });
      expect(screen.getByText('Operation successful')).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(4000);
      });

      expect(screen.queryByText('Operation successful')).not.toBeInTheDocument();
    });

    // A pending timer outlives its provider by up to 4s. Left uncleared it wakes
    // up inside a torn-down environment and takes the whole suite down with
    // "ReferenceError: window is not defined" from React's scheduler.
    it('clears pending timers on unmount', () => {
      vi.useFakeTimers();
      const { unmount } = render(
        <ToastProvider>
          <ToastTester />
        </ToastProvider>
      );

      act(() => {
        screen.getByText('Show Success').click();
      });
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      unmount();

      expect(vi.getTimerCount()).toBe(0);
    });

    it('clears the pending timer when a toast is dismissed by hand', () => {
      vi.useFakeTimers();
      render(
        <ToastProvider>
          <ToastTester />
        </ToastProvider>
      );

      act(() => {
        screen.getByText('Show Success').click();
      });

      act(() => {
        screen.getByRole('button', { name: '' }).click();
      });

      expect(screen.queryByText('Operation successful')).not.toBeInTheDocument();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
