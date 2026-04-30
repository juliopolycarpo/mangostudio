import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import type * as TanstackRouter from '@tanstack/react-router';
import { render } from '../../support/harness/render';
import { ContextSettings } from '../../../src/components/settings/ContextSettings';
import { SettingsTabs } from '../../../src/components/settings/SettingsTabs';
import { DEFAULT_CONTEXT_SETTINGS } from '../../../src/hooks/use-global-settings';

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof TanstackRouter>();
  return {
    ...actual,
    Link: ({
      to,
      children,
      activeProps: _activeProps,
      inactiveProps: _inactiveProps,
      activeOptions: _activeOptions,
      ...props
    }: {
      to: string;
      children: React.ReactNode;
      activeProps?: unknown;
      inactiveProps?: unknown;
      activeOptions?: unknown;
      [key: string]: unknown;
    }) => (
      <a href={to} {...props}>
        {children}
      </a>
    ),
  };
});

function renderSettings(overrides: Partial<React.ComponentProps<typeof ContextSettings>> = {}) {
  const props: React.ComponentProps<typeof ContextSettings> = {
    settings: DEFAULT_CONTEXT_SETTINGS,
    availableModels: [
      {
        modelId: 'gpt-4o-mini',
        resourceName: 'gpt-4o-mini',
        displayName: 'GPT-4o mini',
        supportedActions: ['chat'],
      },
    ],
    setCompactionBehavior: vi.fn(),
    setWarningThreshold: vi.fn(),
    setDangerThreshold: vi.fn(),
    setHardStopThreshold: vi.fn(),
    setPreferredSummaryModel: vi.fn(),
    setProviderCompactionEnabled: vi.fn(),
    ...overrides,
  };

  render(<ContextSettings {...props} />);
  return props;
}

describe('ContextSettings', () => {
  it('renders the context settings sections', () => {
    renderSettings();

    expect(screen.getByText('Context')).toBeInTheDocument();
    expect(screen.getByLabelText('Compaction behavior')).toBeInTheDocument();
    expect(screen.getByLabelText('Preferred summary model')).toBeInTheDocument();
  });

  it('updates compaction behavior through the provided setter', () => {
    const props = renderSettings();

    fireEvent.change(screen.getByLabelText('Compaction behavior'), {
      target: { value: 'off' },
    });

    expect(props.setCompactionBehavior).toHaveBeenCalledWith('off');
  });

  it('updates provider-side compaction through the provided setter', () => {
    const props = renderSettings();

    fireEvent.click(screen.getByLabelText('Allow provider-side compaction'));

    expect(props.setProviderCompactionEnabled).toHaveBeenCalledWith(false);
  });
});

describe('SettingsTabs', () => {
  it('renders a context tab link', () => {
    render(<SettingsTabs />);

    expect(screen.getByRole('link', { name: 'Context' })).toHaveAttribute(
      'href',
      '/settings/context'
    );
  });
});
