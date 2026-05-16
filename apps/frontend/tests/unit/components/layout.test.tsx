import { mockChats } from '@mangostudio/shared/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { Layout } from '../../../src/components/layout/Layout';
import { render, screen } from '../../support/harness/render';

describe('Layout', () => {
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

  it('renders children inside the main content area', () => {
    render(
      <Layout {...defaultProps}>
        <div data-testid="main-content">Main content here</div>
      </Layout>
    );

    expect(screen.getByTestId('main-content')).toBeInTheDocument();
    expect(screen.getByText('Main content here')).toBeInTheDocument();
  });

  it('shows the primary navigation actions', () => {
    render(
      <Layout {...defaultProps}>
        <div>Test</div>
      </Layout>
    );

    expect(screen.getByText('Mango Studio')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /new chat/i })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /gallery/i }).length).toBeGreaterThanOrEqual(1);
  });

  it('exposes the main landmark', () => {
    render(
      <Layout {...defaultProps}>
        <div>Test</div>
      </Layout>
    );

    expect(screen.getByRole('main')).toBeInTheDocument();
  });
});
