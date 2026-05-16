import type { Connector } from '@mangostudio/shared';
import { describe, expect, it, vi } from 'vitest';
import { DeleteConfirmDialog } from '@/features/settings/connectors/components/DeleteConfirmDialog';
import { render, screen } from '../../support/harness/render';

vi.mock('@/hooks/use-i18n', async () => {
  const actual = await vi.importActual('@/hooks/use-i18n');
  return {
    ...(actual as object),
    useI18n: () => ({
      t: {
        settings: {
          connectors: {
            deleteConnector: 'Delete Connector',
            deleteConfirm: 'Are you sure you want to delete',
            cancelButton: 'Cancel',
          },
        },
      },
      locale: 'en',
      setLocale: vi.fn(),
    }),
  };
});

const mockConnector: Connector = {
  id: 'conn-1',
  name: 'My OpenAI Key',
  provider: 'openai',
  configured: true,
  source: 'config-file',
  maskedSuffix: 'abcd',
  enabledModels: ['gpt-4'],
  baseUrl: null,
  organizationId: null,
  projectId: null,
  updatedAt: 1704067200000,
  lastValidatedAt: null,
  lastValidationError: null,
  userId: null,
};

describe('DeleteConfirmDialog', () => {
  it('renders connector name in the confirmation message', () => {
    render(
      <DeleteConfirmDialog connector={mockConnector} onConfirm={vi.fn()} onCancel={vi.fn()} />
    );

    expect(screen.getByText(/My OpenAI Key/)).toBeInTheDocument();
  });

  it('renders cancel and delete buttons', () => {
    render(
      <DeleteConfirmDialog connector={mockConnector} onConfirm={vi.fn()} onCancel={vi.fn()} />
    );

    expect(screen.getByText('Cancel')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete Connector' })).toBeInTheDocument();
  });

  it('calls onCancel when cancel is clicked', () => {
    const onCancel = vi.fn();
    render(
      <DeleteConfirmDialog connector={mockConnector} onConfirm={vi.fn()} onCancel={onCancel} />
    );

    screen.getByText('Cancel').click();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('calls onConfirm when delete is clicked', () => {
    const onConfirm = vi.fn();
    render(
      <DeleteConfirmDialog connector={mockConnector} onConfirm={onConfirm} onCancel={vi.fn()} />
    );

    screen.getByRole('button', { name: 'Delete Connector' }).click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
