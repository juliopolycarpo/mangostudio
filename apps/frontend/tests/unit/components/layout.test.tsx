import { describe, expect, it, jest } from 'bun:test';
import { mockChats } from '@mangostudio/shared/test-utils';
import { Layout } from '../../../src/components/layout/Layout';
import { render, screen } from '../../support/harness/render';

describe('Layout', () => {
  const defaultProps = {
    currentPage: 'chat' as const,
    onNavigate: jest.fn(),
    chats: mockChats,
    currentChatId: 'chat-1',
    onSelectChat: jest.fn(),
    onUpdateChatTitle: jest.fn(),
    onDeleteChat: jest.fn(),
    onNewChat: jest.fn(),
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
