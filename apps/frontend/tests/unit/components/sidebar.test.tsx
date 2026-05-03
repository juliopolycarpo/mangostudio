import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
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

    expect(screen.getByRole('button', { name: /studio/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /gallery/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /settings/i })).toBeInTheDocument();
  });

  it('highlights Studio when it is the current page', () => {
    render(<Sidebar {...defaultProps} currentPage="studio" />);

    const studioButton = screen.getByRole('button', { name: /studio/i });
    expect(studioButton.className).toContain('text-primary');
  });

  it('calls onNavigate with "studio" when Studio is clicked', () => {
    const onNavigate = vi.fn();
    render(<Sidebar {...defaultProps} onNavigate={onNavigate} />);

    fireEvent.click(screen.getByRole('button', { name: /studio/i }));
    expect(onNavigate).toHaveBeenCalledWith('studio');
  });

  it('does not interfere with existing navigation items', () => {
    render(<Sidebar {...defaultProps} />);

    expect(screen.getByRole('button', { name: /gallery/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /settings/i })).toBeInTheDocument();
    expect(screen.getByText('First Chat')).toBeInTheDocument();
  });
});
