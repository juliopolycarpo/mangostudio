import { describe, expect, it, jest, mock } from 'bun:test';
import { fireEvent, screen } from '@testing-library/react';
import { render } from '../../support/harness/render';
import { chooseOption } from '../../support/harness/select';
import { routerWithLinkStub } from '../../support/mocks/router';

mock.module('@tanstack/react-router', await routerWithLinkStub());

// After the mock, never before: a static import is evaluated first and would
// bind SettingsTabs to the real router.
const { ContextSettings } = await import('../../../src/components/settings/ContextSettings');
const { DEFAULT_CONTEXT_SETTINGS } = await import('../../../src/hooks/use-global-settings');

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
    setCompactionBehavior: jest.fn(),
    setWarningThreshold: jest.fn(),
    setDangerThreshold: jest.fn(),
    setHardStopThreshold: jest.fn(),
    setPreferredSummaryModel: jest.fn(),
    setProviderCompactionEnabled: jest.fn(),
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

  it('updates compaction behavior through the provided setter', async () => {
    const props = renderSettings();

    await chooseOption('Compaction behavior', 'Turn prompts off');

    expect(props.setCompactionBehavior).toHaveBeenCalledWith('off');
  });

  it('updates provider-side compaction through the provided setter', () => {
    const props = renderSettings();

    fireEvent.click(screen.getByLabelText('Allow provider-side compaction'));

    expect(props.setProviderCompactionEnabled).toHaveBeenCalledWith(false);
  });
});
