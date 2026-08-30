import { describe, expect, it, jest } from 'bun:test';
import { fireEvent, screen } from '@testing-library/react';
import { ContextSettings } from '../../../src/components/settings/ContextSettings';
import { DEFAULT_CONTEXT_SETTINGS } from '../../../src/hooks/use-global-settings';
import { render } from '../../support/harness/render';
import { chooseOption } from '../../support/harness/select';

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
