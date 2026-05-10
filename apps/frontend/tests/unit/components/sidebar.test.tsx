import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { mockChats } from '@mangostudio/shared/test-utils';
import { render } from '../../support/harness/render';
import { Sidebar } from '../../../src/features/sidebar/components/Sidebar';

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
