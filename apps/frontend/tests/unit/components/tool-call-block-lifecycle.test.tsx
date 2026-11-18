/**
 * What a tool card says about its call's lifecycle beyond the status word: the
 * terminal reason, a running call's clock, and the time limit it is held to.
 */

import { afterEach, describe, expect, it, jest } from 'bun:test';

import { en, ptBR } from '@mangostudio/shared/i18n';
import {
  TOOL_EXECUTION_REASON_CODES,
  type ToolExecutionSnapshot,
} from '@mangostudio/shared/tool-executions';
import { screen, waitFor } from '@testing-library/react';

import { ToolCallBlock } from '@/features/chat/components/ToolCallBlock';
import { formatToolElapsed } from '@/features/chat/components/ToolCallVisuals';

import { render } from '../../support/harness/render';
import { advanceTimersByTimeAsync, useFakeTimers } from '../../support/harness/timers';
import { createFetchScenario } from '../../support/mocks/create-fetch-scenario';

const EPOCH_MS = 1_800_000_000_000;

function snapshot(overrides: Partial<ToolExecutionSnapshot> = {}): ToolExecutionSnapshot {
  return {
    status: 'failed',
    source: 'builtin',
    queuedAt: EPOCH_MS,
    startedAt: EPOCH_MS,
    ...overrides,
  };
}

describe('the terminal reason on a tool card', () => {
  it.each([
    ['failed', 'not_allowed', 'Not allowed'],
    ['failed', 'validation_failed', 'Invalid arguments'],
    ['cancelled', 'user_cancelled', 'Cancelled by you'],
    ['cancelled', 'turn_aborted', 'Turn stopped'],
  ] as const)('names why a %s call ended (%s)', (status, reasonCode, copy) => {
    render(
      <ToolCallBlock
        name="bash"
        args={{ command: 'ls' }}
        status={status}
        execution={snapshot({ status, reasonCode })}
      />
    );
    expect(screen.getByRole('button')).toHaveTextContent(copy);
  });

  it('says nothing extra for a timed-out call, whose status already says it', () => {
    render(
      <ToolCallBlock
        name="bash"
        args={{ command: 'sleep 60' }}
        status="timed_out"
        execution={snapshot({ status: 'timed_out', reasonCode: 'timeout' })}
      />
    );
    const row = screen.getByRole('button');
    expect(row).toHaveTextContent('Timed out');
    expect(row).not.toHaveTextContent(en.tools.reasons.timeout);
  });

  it('shows no reason when the snapshot carries none', () => {
    render(<ToolCallBlock name="bash" args={{}} status="failed" />);
    expect(screen.getByRole('button')).toHaveTextContent(/^.*Failed$/);
  });

  it('shows no reason on a call that succeeded', () => {
    render(
      <ToolCallBlock
        name="bash"
        args={{}}
        status="succeeded"
        execution={snapshot({ status: 'succeeded', reasonCode: 'execution_error' })}
      />
    );
    expect(screen.getByRole('button')).not.toHaveTextContent(en.tools.reasons.execution_error);
  });

  it('has copy in both locales for every reason code the contract defines', () => {
    for (const code of TOOL_EXECUTION_REASON_CODES) {
      expect(en.tools.reasons[code]).toBeTruthy();
      expect(ptBR.tools.reasons[code]).toBeTruthy();
    }
    expect(Object.keys(en.tools.reasons).sort()).toEqual([...TOOL_EXECUTION_REASON_CODES].sort());
  });
});

describe('formatToolElapsed', () => {
  it('floors to whole seconds and never goes negative', () => {
    expect(formatToolElapsed(0)).toBe('0s');
    expect(formatToolElapsed(999)).toBe('0s');
    expect(formatToolElapsed(12_900)).toBe('12s');
    expect(formatToolElapsed(-5_000)).toBe('0s');
  });
});

describe('a running tool card’s clock', () => {
  // The suite-wide afterEach puts real timers back.
  it('counts up from the start the hub recorded, once a second', async () => {
    useFakeTimers();
    jest.setSystemTime(EPOCH_MS + 2_000);
    render(
      <ToolCallBlock
        name="mcp__files__scan"
        args={{}}
        status="running"
        execution={snapshot({ status: 'running', source: 'mcp' })}
      />
    );
    expect(screen.getByRole('button')).toHaveTextContent('2s');

    await advanceTimersByTimeAsync(3_000);
    expect(screen.getByRole('button')).toHaveTextContent('5s');

    await advanceTimersByTimeAsync(1_000);
    expect(screen.getByRole('button')).toHaveTextContent('6s');
  });

  it('counts from when the card first saw the call when no snapshot exists', async () => {
    useFakeTimers();
    jest.setSystemTime(EPOCH_MS);
    render(<ToolCallBlock name="mcp__files__scan" args={{}} status="running" />);
    expect(screen.getByRole('button')).toHaveTextContent('0s');

    await advanceTimersByTimeAsync(4_000);
    expect(screen.getByRole('button')).toHaveTextContent('4s');
  });

  it('hands over to the measured duration and stops ticking when the call settles', async () => {
    useFakeTimers();
    jest.setSystemTime(EPOCH_MS);
    const { rerender } = render(
      <ToolCallBlock
        name="mcp__files__scan"
        args={{}}
        status="running"
        execution={snapshot({ status: 'running', source: 'mcp' })}
      />
    );
    await advanceTimersByTimeAsync(3_000);
    expect(screen.getByRole('button')).toHaveTextContent('3s');

    rerender(
      <ToolCallBlock
        name="mcp__files__scan"
        args={{}}
        status="succeeded"
        result='"ok"'
        execution={snapshot({ status: 'succeeded', source: 'mcp', durationMs: 3_240 })}
      />
    );
    expect(screen.getByRole('button')).toHaveTextContent('3.2s');

    await advanceTimersByTimeAsync(10_000);
    expect(screen.getByRole('button')).toHaveTextContent('3.2s');
    expect(screen.getByRole('button')).not.toHaveTextContent('13s');
  });

  it('does not run a clock for a call waiting on the reader', async () => {
    useFakeTimers();
    jest.setSystemTime(EPOCH_MS);
    render(
      <ToolCallBlock
        name="ask_user_question"
        args={{}}
        status="awaiting_user"
        execution={snapshot({ status: 'awaiting_user' })}
      />
    );
    await advanceTimersByTimeAsync(5_000);
    expect(screen.getByRole('button')).not.toHaveTextContent(/\d+s/);
  });
});

describe('a running built-in tool card’s time limit', () => {
  const scenario = createFetchScenario();

  afterEach(() => {
    scenario.restore();
  });

  /** Other queries on the card (the display settings) hit the same fetch. */
  function toolSettingsRequests() {
    return scenario.fetchMock.mock.calls.filter(([input]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return url.includes('/settings/tools');
    });
  }

  function respondWithToolSettings(timeoutSeconds: unknown) {
    scenario
      .respondWithJson('GET', '/api/settings/tools', {
        body: {
          tools: [
            {
              name: 'bash',
              title: 'Bash',
              description: 'Runs a shell command.',
              category: 'system',
              enabled: true,
              canDisable: true,
              parameters: { timeoutSeconds },
              parameterDescriptors: [],
            },
          ],
        },
      })
      .install();
  }

  it('shows the clock against the limit the tool settings give it', async () => {
    respondWithToolSettings(45);
    render(
      <ToolCallBlock
        name="bash"
        args={{ command: 'make' }}
        status="running"
        execution={snapshot({ status: 'running', startedAt: Date.now() - 12_000 })}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole('button')).toHaveTextContent(/\d+s of 45s/);
    });
  });

  it('shows the bare clock when the setting is not a usable number', async () => {
    respondWithToolSettings('soon');
    render(
      <ToolCallBlock
        name="bash"
        args={{ command: 'make' }}
        status="running"
        execution={snapshot({ status: 'running', startedAt: Date.now() - 12_000 })}
      />
    );

    await waitFor(() => expect(toolSettingsRequests().length).toBeGreaterThan(0));
    expect(screen.getByRole('button')).toHaveTextContent(/\d+s/);
    expect(screen.getByRole('button')).not.toHaveTextContent(' of ');
  });

  it('asks for the settings only while a built-in call is running', async () => {
    respondWithToolSettings(45);
    render(
      <ToolCallBlock
        name="bash"
        args={{ command: 'make' }}
        status="succeeded"
        execution={snapshot({ status: 'succeeded', durationMs: 900 })}
      />
    );
    render(
      <ToolCallBlock
        name="mcp__files__scan"
        args={{}}
        status="running"
        execution={snapshot({ status: 'running', source: 'mcp' })}
      />
    );

    // Give a stray request time to land before asserting there was none.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(toolSettingsRequests()).toHaveLength(0);
  });
});
