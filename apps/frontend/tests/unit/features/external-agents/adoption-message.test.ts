import { describe, expect, it } from 'bun:test';

import { ERROR_CODES } from '@mangostudio/shared/errors';
import { en } from '@mangostudio/shared/i18n';

import { adoptionMessage } from '@/features/external-agents/RunnerSelectorContainer';

describe('adoptionMessage', () => {
  it('tells the user the machine is unreachable for ENVIRONMENT_UNAVAILABLE', () => {
    expect(adoptionMessage(ERROR_CODES.ENVIRONMENT_UNAVAILABLE, en)).toBe(
      en.externalAgents.sessions.unreachable
    );
  });

  it('does not call a provider failure an unreachable machine', () => {
    expect(adoptionMessage(ERROR_CODES.PROVIDER_ERROR, en)).toBe(
      en.externalAgents.sessions.adoptFailed
    );
  });
});
