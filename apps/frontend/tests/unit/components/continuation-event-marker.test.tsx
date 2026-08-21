import { describe, expect, it } from 'bun:test';
import { screen } from '@testing-library/react';
import { ContinuationEventMarker } from '../../../src/features/chat/components/ContinuationEventMarker';
import { render } from '../../support/harness/render';

describe('ContinuationEventMarker', () => {
  it('renders cursor_expired label with provider and fromMode', () => {
    render(
      <ContinuationEventMarker
        provider="openai"
        modelName="gpt-4o"
        fromMode="responses"
        toMode="replay"
        reasonCode="cursor_expired"
        recovered={true}
      />
    );

    expect(screen.getByText(/cursor expired/i)).toBeInTheDocument();
    expect(screen.getByText(/openai/i)).toBeInTheDocument();
    expect(screen.getByText(/responses/i)).toBeInTheDocument();
  });

  it('renders provider_changed label with fromProvider and toMode', () => {
    render(
      <ContinuationEventMarker
        provider="gemini"
        modelName="gemini-2.0-flash"
        fromProvider="openai"
        fromMode="responses"
        toMode="replay"
        reasonCode="provider_changed"
        recovered={true}
      />
    );

    // Should include both provider names
    expect(screen.getByText(/openai/i)).toBeInTheDocument();
    expect(screen.getByText(/gemini/i)).toBeInTheDocument();
  });

  it('shows recovered suffix when recovered is true', () => {
    render(
      <ContinuationEventMarker
        provider="openai"
        modelName="gpt-4o"
        fromMode="responses"
        toMode="replay"
        reasonCode="cursor_expired"
        recovered={true}
      />
    );

    expect(screen.getByText(/\(recovered\)/i)).toBeInTheDocument();
  });

  it('shows not recovered suffix when recovered is false', () => {
    render(
      <ContinuationEventMarker
        provider="openai"
        modelName="gpt-4o"
        fromMode="responses"
        toMode="tool_loop_aborted"
        reasonCode="tool_result_cursor_loss"
        recovered={false}
      />
    );

    expect(screen.getByText(/not recovered/i)).toBeInTheDocument();
  });

  it('renders system_prompt_changed label', () => {
    render(
      <ContinuationEventMarker
        provider="openai"
        modelName="gpt-4o"
        fromMode="responses"
        toMode="replay"
        reasonCode="system_prompt_changed"
        recovered={true}
      />
    );

    expect(screen.getByText(/system prompt changed/i)).toBeInTheDocument();
  });

  it('renders agent_runtime_changed label', () => {
    render(
      <ContinuationEventMarker
        provider="openai"
        modelName="gpt-4o"
        fromMode="responses"
        toMode="replay"
        reasonCode="agent_runtime_changed"
        recovered={true}
      />
    );

    expect(screen.getByText(/agent settings changed/i)).toBeInTheDocument();
  });

  it('renders envelope_malformed label without provider placeholders', () => {
    render(
      <ContinuationEventMarker
        provider="openai"
        modelName="gpt-4o"
        fromMode="responses"
        toMode="replay"
        reasonCode="envelope_malformed"
        recovered={false}
      />
    );

    expect(screen.getByText(/unreadable/i)).toBeInTheDocument();
  });
});
