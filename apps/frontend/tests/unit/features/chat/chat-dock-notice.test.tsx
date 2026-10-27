/**
 * The notices above the composer stack in one dock. If each guessed its own
 * gutter, two callouts on a phone sat at different left edges and neither lined
 * up with the composer under them — so they share one row, on the composer
 * footer's own gutter ladder, in the column the transcript and the composer use.
 * The step between them is below each one, so the transcript runs down to the
 * first notice's edge instead of stopping a padding short of it.
 */

import { describe, expect, it, jest } from 'bun:test';

import { en } from '@mangostudio/shared/i18n';
import type { TurnCheckpointPart } from '@mangostudio/shared/turn-recovery';
import { screen } from '@testing-library/react';

import {
  ChatContextDecisionNotice,
  ChatFallbackNotice,
} from '../../../../src/features/chat/components/ChatPageNotices';
import { DeprecatedModelNotice } from '../../../../src/features/chat/components/DeprecatedModelNotice';
import { InterruptedTurnNotice } from '../../../../src/features/chat/components/InterruptedTurnNotice';
import { render } from '../../../support/harness/render';

const CHECKPOINT: TurnCheckpointPart = {
  type: 'turn_checkpoint',
  version: 1,
  turnId: 'turn-1',
  status: 'interrupted',
  reasonCode: 'server_restart',
  sequence: 1,
  startedAt: 1,
  checkpointedAt: 2,
  provider: 'openai',
  modelName: 'gpt-test',
  agentId: 'default',
  lastAssistantText: '',
  todoSnapshot: [],
  completedCalls: [],
  incompleteCalls: [],
};

/** The row a notice sits in: the parent of the column that holds its content. */
function dockRow(content: HTMLElement): HTMLElement {
  const column = content.closest('.max-w-4xl');
  expect(column, 'expected the notice to sit in the chat column').not.toBeNull();
  return column?.parentElement as HTMLElement;
}

const NOTICES: ReadonlyArray<readonly [string, () => HTMLElement]> = [
  [
    'fallback',
    () => {
      render(<ChatFallbackNotice notice={{ from: 'a', to: 'replay', reason: 'stateless' }} />);
      return screen.getByText(en.chat.fallback.toReplay);
    },
  ],
  [
    'context decision',
    () => {
      render(
        <ChatContextDecisionNotice
          warningMessage="Nearly full."
          isPending={false}
          onCompact={jest.fn()}
          onStartSummarizedChat={jest.fn()}
          onContinue={jest.fn()}
        />
      );
      return screen.getByText('Nearly full.');
    },
  ],
  [
    'deprecated model',
    () => {
      render(
        <DeprecatedModelNotice
          details={{
            reason: 'provider-deprecated',
            action: 'fork-with-external-runner',
            modelId: 'cursor/composer-2.5',
            provider: 'cursor',
            targetId: 'cursor',
          }}
          isForking={false}
          runnerAvailable
          onContinueWithRunner={jest.fn()}
          onDismiss={jest.fn()}
        />
      );
      return screen.getByRole('button', { name: /continue in a new chat/i });
    },
  ],
  [
    'interrupted turn',
    () => {
      render(
        <InterruptedTurnNotice
          messageId="message-1"
          checkpoint={CHECKPOINT}
          disabled={false}
          onResume={jest.fn().mockResolvedValue(undefined)}
          onDismiss={jest.fn().mockResolvedValue(undefined)}
        />
      );
      return screen.getByText(en.chat.recovery.title);
    },
  ],
];

describe('dock notices', () => {
  it.each(NOTICES)('puts the %s notice on the composer footer’s gutter ladder', (_name, show) => {
    const row = dockRow(show());
    for (const token of ['px-3', 'sm:px-4', 'md:px-6', 'pb-3']) {
      expect(row.className.split(/\s+/)).toContain(token);
    }
    // The guesses it replaced: a 24px phone gutter and a 16px gap.
    expect(row.className.split(/\s+/)).not.toContain('px-6');
    expect(row.className.split(/\s+/)).not.toContain('pb-4');
    // No gap above: that strip of canvas is what the transcript was clipped at.
    expect(row.className.split(/\s+/)).not.toContain('pt-3');
  });

  it('keeps the interrupted notice a live region as a whole', () => {
    const row = dockRow(NOTICES[3][1]());
    expect(row).toHaveAttribute('role', 'status');
    expect(row).toHaveAttribute('aria-live', 'polite');
  });
});
