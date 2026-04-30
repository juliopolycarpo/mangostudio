import { describe, it, expect } from 'vitest';
import { render, screen, act } from '../../../support/harness/render';
import { ToastProvider, useToast } from '@/components/ui/Toast';

function ToastTester() {
  const { toast } = useToast();

  return (
    <div>
      <button onClick={() => toast('Operation successful', 'success')}>Show Success</button>
      <button onClick={() => toast('Something failed', 'error')}>Show Error</button>
      <button onClick={() => toast('Just info')}>Show Info</button>
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
});
