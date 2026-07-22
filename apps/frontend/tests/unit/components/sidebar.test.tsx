import { mockChats } from '@mangostudio/shared/test-utils';
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Sidebar } from '../../../src/features/sidebar/components/Sidebar';
import { render } from '../../support/harness/render';

const defaultProps = {
  currentPage: 'chat' as const,
  onNavigate: vi.fn(),
  chats: mockChats,
  currentChatId: 'chat-1',
  onSelectChat: vi.fn(),
  onUpdateChatTitle: vi.fn(),
  onDeleteChat: vi.fn(),
  onNewChat: vi.fn(),
};

describe('Sidebar', () => {
  it('renders navigation items for all top-level pages', () => {
    render(<Sidebar {...defaultProps} />);

    expect(screen.getAllByRole('button', { name: /studio/i }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole('button', { name: /gallery/i }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole('button', { name: /settings/i }).length).toBeGreaterThanOrEqual(1);
  });

  it('highlights Studio when it is the current page', () => {
    render(<Sidebar {...defaultProps} currentPage="studio" />);

    const studioButtons = screen.getAllByRole('button', { name: /studio/i });
    expect(studioButtons[0].className).toContain('text-primary');
  });

  it('calls onNavigate with "studio" when Studio is clicked', () => {
    const onNavigate = vi.fn();
    render(<Sidebar {...defaultProps} onNavigate={onNavigate} />);

    fireEvent.click(screen.getAllByRole('button', { name: /studio/i })[0]);
    expect(onNavigate).toHaveBeenCalledWith('studio');
  });

  it('does not interfere with existing navigation items', () => {
    render(<Sidebar {...defaultProps} />);

    expect(screen.getAllByRole('button', { name: /gallery/i }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole('button', { name: /settings/i }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('First Chat')).toBeInTheDocument();
  });

  it('is visible on mobile when isMobileOpen is true', () => {
    const { container } = render(<Sidebar {...defaultProps} isMobileOpen />);
    const aside = container.querySelector('aside');
    expect(aside?.className).toContain('flex');
    expect(aside?.className).not.toContain('hidden');
  });

  it('is hidden on mobile when isMobileOpen is false', () => {
    const { container } = render(<Sidebar {...defaultProps} isMobileOpen={false} />);
    const aside = container.querySelector('aside');
    expect(aside?.className).toContain('hidden');
  });

  it('exposes chat titles through the title attribute when truncated', () => {
    render(<Sidebar {...defaultProps} />);
    expect(screen.getByText('First Chat')).toHaveAttribute('title', 'First Chat');
  });

  it('resizes from the keyboard and persists the clamped width', () => {
    const onWidthChange = vi.fn();
    const { container } = render(
      <Sidebar {...defaultProps} width={256} onWidthChange={onWidthChange} />
    );
    const handle = screen.getByRole('separator', { name: /resize chat sidebar/i });
    expect(handle).toHaveAttribute('aria-valuenow', '256');
    // `h-auto` overrides the preflight `hr { height: 0 }`; without it the handle is unhittable.
    expect(handle).toHaveClass('h-auto');
    expect(handle.nextElementSibling).toHaveClass('bg-outline-variant/50');

    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    fireEvent.keyUp(handle, { key: 'ArrowRight' });
    expect(onWidthChange).toHaveBeenCalledWith(272);
    expect(container.querySelector('aside')).toHaveStyle({ width: '272px' });
  });

  // The rail handle sits on the opposite edge, so a shared component that mixed
  // the two directions up would still pass the rail's drag test.
  it('grows the sidebar when its right-edge handle is dragged right', () => {
    const onWidthPreview = vi.fn();
    const { container } = render(
      <Sidebar
        {...defaultProps}
        width={256}
        onWidthPreview={onWidthPreview}
        onWidthChange={vi.fn()}
      />
    );
    const handle = screen.getByRole('separator', { name: /resize chat sidebar/i });

    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 256 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 296 });

    expect(onWidthPreview).toHaveBeenLastCalledWith(296);
    expect(container.querySelector('aside')).toHaveStyle({ width: '296px' });
  });

  it('mobile shortcuts close the sidebar after navigation', () => {
    const onNavigate = vi.fn();
    const onMobileClose = vi.fn();
    render(<Sidebar {...defaultProps} onNavigate={onNavigate} onMobileClose={onMobileClose} />);

    const shortcuts = screen.getByTestId('mobile-shortcuts');
    fireEvent.click(within(shortcuts).getByRole('button', { name: /studio/i }));
    expect(onNavigate).toHaveBeenCalledWith('studio');
    expect(onMobileClose).toHaveBeenCalled();
  });
});
