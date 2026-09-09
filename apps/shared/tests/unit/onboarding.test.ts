import { describe, expect, it } from 'bun:test';
import Value from 'typebox/value';
import {
  DEFAULT_ONBOARDING_STATE,
  isOnboardingComplete,
  normalizeOnboardingState,
  type OnboardingMachineFacts,
  type OnboardingState,
  OnboardingStateSchema,
  onboardingStepStatuses,
  resumeOnboarding,
} from '../../src/onboarding';

const allUnsatisfied: OnboardingMachineFacts = {
  folder: 'unsatisfied',
  toolchain: 'unsatisfied',
  agents: 'unsatisfied',
  service: 'unsatisfied',
  chat: 'unsatisfied',
};

const allSatisfied: OnboardingMachineFacts = {
  folder: 'satisfied',
  toolchain: 'satisfied',
  agents: 'satisfied',
  service: 'satisfied',
  chat: 'satisfied',
};

function stateOf(overrides: Partial<OnboardingState> = {}): OnboardingState {
  return { ...DEFAULT_ONBOARDING_STATE, ...overrides };
}

describe('normalizeOnboardingState', () => {
  it('returns the untouched default for a missing record', () => {
    expect(normalizeOnboardingState(undefined)).toEqual(DEFAULT_ONBOARDING_STATE);
    expect(normalizeOnboardingState(null)).toEqual(DEFAULT_ONBOARDING_STATE);
    expect(normalizeOnboardingState('nope')).toEqual(DEFAULT_ONBOARDING_STATE);
  });

  it('drops step ids this build no longer knows', () => {
    const state = normalizeOnboardingState({
      welcomeAcknowledged: true,
      skippedSteps: ['folder', 'retired-step', 42],
    });

    expect(state.skippedSteps).toEqual(['folder']);
  });

  it('deduplicates skipped steps and stores them in flow order', () => {
    const state = normalizeOnboardingState({
      skippedSteps: ['chat', 'folder', 'chat'],
    });

    expect(state.skippedSteps).toEqual(['folder', 'chat']);
  });

  it('keeps the rest of the record when one field is malformed', () => {
    const state = normalizeOnboardingState({
      completedAt: 1_700_000_000_000,
      welcomeAcknowledged: true,
      skippedSteps: [],
      workdir: '   ',
      environmentId: 'local',
      runner: { kind: 'nonsense' },
      chatId: 'chat-1',
    });

    expect(state.completedAt).toBe(1_700_000_000_000);
    expect(state.environmentId).toBe('local');
    expect(state.chatId).toBe('chat-1');
    expect(state.workdir).toBeUndefined();
    expect(state.runner).toBeUndefined();
  });

  it('keeps a runner the chat contract still accepts', () => {
    const state = normalizeOnboardingState({
      skippedSteps: [],
      runner: { kind: 'external', targetId: 'claude' },
    });

    expect(state.runner).toEqual({ kind: 'external', targetId: 'claude' });
  });

  it('produces a value the published schema accepts', () => {
    const state = normalizeOnboardingState({
      completedAt: 12,
      welcomeAcknowledged: true,
      skippedSteps: ['service'],
      environmentId: 'local',
      workdir: '/home/dev/project',
      runner: { kind: 'mangostudio', agentId: 'default' },
      chatId: 'chat-9',
    });

    expect(Value.Check(OnboardingStateSchema, state)).toBe(true);
  });

  it('rejects a negative or fractional completion timestamp by flooring it into range', () => {
    expect(normalizeOnboardingState({ completedAt: -5, skippedSteps: [] }).completedAt).toBe(0);
    expect(normalizeOnboardingState({ completedAt: 10.9, skippedSteps: [] }).completedAt).toBe(10);
    expect(
      normalizeOnboardingState({ completedAt: Number.NaN, skippedSteps: [] }).completedAt
    ).toBeUndefined();
  });
});

describe('isOnboardingComplete', () => {
  it('is false until a completion timestamp exists', () => {
    expect(isOnboardingComplete(stateOf())).toBe(false);
    expect(isOnboardingComplete(stateOf({ completedAt: 1 }))).toBe(true);
  });
});

describe('onboardingStepStatuses', () => {
  it('reports a satisfied step even when it was skipped earlier', () => {
    const statuses = onboardingStepStatuses(stateOf({ skippedSteps: ['toolchain'] }), {
      ...allUnsatisfied,
      toolchain: 'satisfied',
    });

    expect(statuses.toolchain).toBe('satisfied');
  });

  it('reports a skipped step that is still unsatisfied as skipped', () => {
    const statuses = onboardingStepStatuses(stateOf({ skippedSteps: ['service'] }), allUnsatisfied);

    expect(statuses.service).toBe('skipped');
  });

  it('separates a step that cannot be acted on here from one that is merely unfinished', () => {
    const statuses = onboardingStepStatuses(stateOf(), {
      ...allUnsatisfied,
      service: 'unavailable',
    });

    expect(statuses.service).toBe('unavailable');
    expect(statuses.folder).toBe('pending');
  });

  it('answers the welcome step from the persisted bit, not from a machine fact', () => {
    expect(onboardingStepStatuses(stateOf(), allSatisfied).welcome).toBe('pending');
    expect(
      onboardingStepStatuses(stateOf({ welcomeAcknowledged: true }), allUnsatisfied).welcome
    ).toBe('satisfied');
  });
});

describe('resumeOnboarding', () => {
  it('opens at welcome for a brand-new person', () => {
    expect(resumeOnboarding(stateOf(), allUnsatisfied)).toEqual({ kind: 'step', step: 'welcome' });
  });

  it('walks past satisfied and skipped steps to the first real question', () => {
    const resume = resumeOnboarding(
      stateOf({ welcomeAcknowledged: true, skippedSteps: ['folder'] }),
      { ...allUnsatisfied, toolchain: 'satisfied' }
    );

    expect(resume).toEqual({ kind: 'step', step: 'agents' });
  });

  it('refuses to answer while an earlier fact is still unknown', () => {
    const resume = resumeOnboarding(stateOf({ welcomeAcknowledged: true }), {
      ...allUnsatisfied,
      folder: 'unknown',
    });

    expect(resume).toEqual({ kind: 'undecided' });
  });

  it('does not let a later pending step jump an unknown one', () => {
    const resume = resumeOnboarding(stateOf({ welcomeAcknowledged: true }), {
      ...allSatisfied,
      toolchain: 'unknown',
      agents: 'unsatisfied',
    });

    expect(resume).toEqual({ kind: 'undecided' });
  });

  it('walks past a step that cannot be acted on here', () => {
    const resume = resumeOnboarding(stateOf({ welcomeAcknowledged: true }), {
      ...allSatisfied,
      service: 'unavailable',
      chat: 'unsatisfied',
    });

    expect(resume).toEqual({ kind: 'step', step: 'chat' });
  });

  it('is done once every step is satisfied or skipped', () => {
    expect(resumeOnboarding(stateOf({ welcomeAcknowledged: true }), allSatisfied)).toEqual({
      kind: 'done',
    });
  });

  it('is done for a completed record regardless of what the machine now says', () => {
    expect(resumeOnboarding(stateOf({ completedAt: 1 }), allUnsatisfied)).toEqual({ kind: 'done' });
  });

  it('sends someone back to a step the machine stopped satisfying', () => {
    const resume = resumeOnboarding(stateOf({ welcomeAcknowledged: true, workdir: '/gone' }), {
      ...allSatisfied,
      folder: 'unsatisfied',
    });

    expect(resume).toEqual({ kind: 'step', step: 'folder' });
  });
});
