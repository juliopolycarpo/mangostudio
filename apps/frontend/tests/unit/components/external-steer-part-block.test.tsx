/**
 * What a mid-turn steer shows for each outcome, and that an unknown delivery
 * reads as a warning to check the agent, not as a refusal.
 */

import { describe, expect, it } from 'bun:test';

import { en } from '@mangostudio/shared/i18n';
import type { ExternalSteerPart } from '@mangostudio/shared/types';
import { screen } from '@testing-library/react';

import { ExternalSteerPartBlock } from '../../../src/features/chat/components/ExternalSteerPartBlock';
import { render } from '../../support/harness/render';

function steerPart(overrides: Partial<ExternalSteerPart> = {}): ExternalSteerPart {
  return {
    type: 'external_steer',
    targetId: 'codex',
    clientMessageId: 'steer-1',
    text: 'use the existing helper',
    status: 'accepted',
    createdAt: 0,
    ...overrides,
  };
}

describe('ExternalSteerPartBlock', () => {
  it('shows the text alone for an accepted steer', () => {
    render(<ExternalSteerPartBlock part={steerPart()} />);

    expect(screen.getByText('use the existing helper')).toBeTruthy();
    expect(screen.queryByText(en.externalAgents.steer.rejectedLabel)).toBeNull();
    expect(screen.queryByText(en.externalAgents.steer.deliveryUnknownLabel)).toBeNull();
  });

  it('shows the refusal and its reason for a rejected steer', () => {
    render(
      <ExternalSteerPartBlock
        part={steerPart({ status: 'rejected', reasonCode: 'turn-not-steerable' })}
      />
    );

    expect(
      screen.getByText(
        `${en.externalAgents.steer.rejectedLabel} — ${en.externalAgents.steer.reason['turn-not-steerable']}`
      )
    ).toBeTruthy();
  });

  it('tells the user to check the agent before resending when delivery is unknown', () => {
    const { container } = render(
      <ExternalSteerPartBlock part={steerPart({ status: 'delivery-unknown' })} />
    );

    expect(screen.getByText('use the existing helper')).toBeTruthy();
    expect(screen.getByText(en.externalAgents.steer.deliveryUnknownLabel)).toBeTruthy();
    expect(screen.getByText(en.externalAgents.steer.deliveryUnknownHint)).toBeTruthy();
    // Not the refusal: the agent may have taken it.
    expect(screen.queryByText(en.externalAgents.steer.rejectedLabel)).toBeNull();
    // Warning tone, not danger: the fill class is the tone's only carrier.
    expect(container.querySelector('.bg-warning-subtle')).not.toBeNull();
    expect(container.querySelector('.bg-danger-subtle')).toBeNull();
  });

  it('keeps a rejection danger-toned', () => {
    const { container } = render(
      <ExternalSteerPartBlock
        part={steerPart({ status: 'rejected', reasonCode: 'not-supported' })}
      />
    );

    expect(container.querySelector('.bg-danger-subtle')).not.toBeNull();
    expect(container.querySelector('.bg-warning-subtle')).toBeNull();
  });
});
