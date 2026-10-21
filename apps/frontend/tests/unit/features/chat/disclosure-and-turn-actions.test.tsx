/**
 * What a touch screen can reach in the transcript, and what the disclosure marks
 * look like.
 *
 * Tailwind wraps `hover:` and `group-hover:` in `@media (hover: hover)`, so a
 * control revealed only by hover is not merely hidden on a phone, it is
 * unreachable: a tool row with no sign it opens, a turn with no copy or revert.
 * happy-dom does not evaluate media queries, so these pin the classes that carry
 * the touch and keyboard reveal rather than the computed opacity.
 */

import { describe, expect, it } from 'bun:test';
import { createMockMessage } from '@mangostudio/shared/test-utils';
import type { MessagePart } from '@mangostudio/shared/types';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CopyMessageButton } from '../../../../src/features/chat/components/CopyMessageButton';
import { GeneratedImagePart } from '../../../../src/features/chat/components/GeneratedImagePart';
import { SubagentTracePart } from '../../../../src/features/chat/components/parts/SubagentTracePart';
import { TimelineRow } from '../../../../src/features/chat/components/TimelineRow';
import { TurnSeparator } from '../../../../src/features/chat/components/TurnSeparator';
import { TURN_ACTION_REVEAL } from '../../../../src/features/chat/lib/turn-action-reveal';
import { deriveTurnStatus } from '../../../../src/features/chat/lib/turn-status';
import { render } from '../../../support/harness/render';
import { ToolIdentitiesProbe } from '../../../support/mocks/tool-identities';

/** The chevron a disclosure draws, found by what it is rather than where it sits. */
function chevronsIn(root: Element): SVGElement[] {
  return Array.from(root.querySelectorAll<SVGElement>('svg.lucide-chevron-down'));
}

describe('TimelineRow disclosure chevron', () => {
  it('stays out of the way for a pointer but is on show for touch and keyboard', () => {
    render(
      <TimelineRow expanded={false} onToggle={() => undefined}>
        Grep
      </TimelineRow>
    );

    const [chevron] = chevronsIn(screen.getByRole('button', { name: /Grep/ }));
    const classes = chevron?.getAttribute('class') ?? '';
    expect(classes).toContain('opacity-0');
    expect(classes).toContain('group-hover/row:opacity-100');
    expect(classes).toContain('group-focus-visible/row:opacity-100');
    expect(classes).toContain('pointer-coarse:opacity-100');
  });

  it('is fully shown and turned over while the row is open', () => {
    render(
      <TimelineRow expanded onToggle={() => undefined}>
        Grep
      </TimelineRow>
    );

    const classes = chevronsIn(screen.getByRole('button', { name: /Grep/ }))[0]?.getAttribute(
      'class'
    );
    expect(classes).toContain('rotate-180');
    expect(classes).not.toContain('opacity-0');
  });

  it('keeps the chevron to a row that can open', () => {
    render(
      <TimelineRow expanded={false} disclosable={false}>
        Read
      </TimelineRow>
    );

    expect(document.querySelector('svg.lucide-chevron-down')).toBeNull();
  });
});

describe('turn actions on the separator', () => {
  const REVEAL_TERMS = TURN_ACTION_REVEAL.split(' ');

  it('are shown at rest on a touch screen, not only on hover', () => {
    expect(REVEAL_TERMS).toContain('opacity-0');
    expect(REVEAL_TERMS).toContain('group-hover:opacity-100');
    expect(REVEAL_TERMS).toContain('focus-visible:opacity-100');
    expect(REVEAL_TERMS).toContain('pointer-coarse:opacity-100');
  });

  it('reveal the copy button on hover, focus and touch, and keep the timestamp on screen', () => {
    const msg = createMockMessage({ role: 'ai', modelName: 'gpt-5.2', isGenerating: false });
    const parts: MessagePart[] = [];

    render(
      <>
        <CopyMessageButton msg={msg} label="Copy message" copiedLabel="Copied" />
        <ToolIdentitiesProbe>
          {(toolIdentities) => (
            <TurnSeparator
              msg={msg}
              parts={parts}
              status={deriveTurnStatus(parts, false)}
              isImageTurn={false}
              toolIdentities={toolIdentities}
            />
          )}
        </ToolIdentitiesProbe>
      </>
    );

    const copyButtons = screen.getAllByTitle('Copy message');
    expect(copyButtons.length).toBeGreaterThan(0);
    for (const button of copyButtons) {
      for (const term of REVEAL_TERMS) expect(button.className).toContain(term);
    }

    // The timestamp is not an action: it is there at rest, as a user bubble's is,
    // so the same fact is not on one side of the conversation and hidden on the other.
    const timestamp = screen.getByText(/^\d{1,2}:\d{2}/);
    expect(timestamp.className).not.toContain('opacity-0');
    expect(timestamp.closest('[class*="opacity-0"]')).toBeNull();
  });

  // The cluster sits on top of the rule's right end instead of in the row, so
  // the rule always reaches the column edge and revealing the buttons reflows
  // nothing. At rest the buttons' backdrop is as invisible as they are.
  it('hold the actions out of the row so the rule runs the whole width', () => {
    const msg = createMockMessage({ role: 'ai', modelName: 'gpt-5.2', isGenerating: false });
    const parts: MessagePart[] = [];

    render(
      <ToolIdentitiesProbe>
        {(toolIdentities) => (
          <TurnSeparator
            msg={msg}
            parts={parts}
            status={deriveTurnStatus(parts, false)}
            isImageTurn={false}
            toolIdentities={toolIdentities}
          />
        )}
      </ToolIdentitiesProbe>
    );

    const row = screen.getByTitle('Copy message').closest('.relative');
    const cluster = screen.getByTitle('Copy message').closest('.absolute');
    expect(row).not.toBeNull();
    expect(cluster).not.toBeNull();
    expect(cluster?.className).toContain('right-0');
    // The rule is a sibling of the cluster's parent row's other children, never inside it.
    const rule = row?.querySelector(':scope > .flex-1');
    expect(rule).not.toBeNull();
    expect(cluster?.contains(rule as Node)).toBe(false);
  });
});

describe('disclosure cards', () => {
  const trace = {
    type: 'subagent_trace',
    toolCallId: 'call-1',
    agentId: 'explorer',
    agentName: 'Explorer',
    status: 'completed',
    summary: 'Looked around',
    toolCallCount: 2,
    messages: [],
    tools: [],
  } as const;

  // The subagent card used to lead with a right-pointing chevron that swapped for
  // a down-pointing one. It now turns the same trailing chevron the tool rows and
  // the image card do.
  it('turns one trailing chevron on the subagent card instead of swapping two', async () => {
    const user = userEvent.setup();
    render(<SubagentTracePart part={trace} />);

    const header = screen.getByRole('button', { name: /Explorer/ });
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(header.querySelector('svg.lucide-chevron-right')).toBeNull();
    expect(header.lastElementChild?.getAttribute('class')).not.toContain('rotate-180');

    await user.click(header);

    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(header.querySelector('svg.lucide-chevron-up')).toBeNull();
    const chevron = chevronsIn(header);
    expect(chevron).toHaveLength(1);
    expect(chevron[0]?.getAttribute('class')).toContain('rotate-180');
    expect(header.lastElementChild).toBe(chevron[0] ?? null);
  });

  it('tells assistive technology whether the image card is open', async () => {
    const user = userEvent.setup();
    render(
      <GeneratedImagePart
        part={{
          type: 'generated_image',
          imageId: 'image-1',
          toolCallId: 'call-1',
          status: 'completed',
          prompt: 'Paint mangoes',
          imageUrl: '/api/images/image-1',
        }}
      />
    );

    const header = screen.getByRole('button', { name: /Paint mangoes/ });
    expect(header).toHaveAttribute('aria-expanded', 'true');

    await user.click(header);

    expect(header).toHaveAttribute('aria-expanded', 'false');
  });
});
