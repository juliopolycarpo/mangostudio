import Value from 'typebox/value';
import { type ChatRunnerConfiguration, ChatRunnerConfigurationSchema } from '../chat/schemas';
import {
  ID_MAX_LENGTH,
  ONBOARDING_STEP_IDS,
  type OnboardingState,
  type OnboardingStepId,
  WORKDIR_MAX_LENGTH,
} from './schemas';

/** A person who has not started: nothing acknowledged, nothing skipped, nothing chosen. */
export const DEFAULT_ONBOARDING_STATE: OnboardingState = {
  welcomeAcknowledged: false,
  skippedSteps: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOnboardingStepId(value: unknown): value is OnboardingStepId {
  return typeof value === 'string' && (ONBOARDING_STEP_IDS as readonly string[]).includes(value);
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) return undefined;
  return trimmed;
}

function runnerOf(value: unknown): ChatRunnerConfiguration | undefined {
  // Checked against the chat contract rather than re-validated by hand: a
  // vendor removed from the target union must stop resolving here too, and one
  // definition is the only way that stays true.
  return Value.Check(ChatRunnerConfigurationSchema, value) ? value : undefined;
}

/**
 * Read persisted onboarding progress, dropping anything this build cannot act
 * on. A step id retired by a later release, a runner whose vendor was removed
 * or a path longer than any filesystem accepts must not strand someone in a
 * wizard that cannot render them — each falls back to "not answered yet", which
 * is always a recoverable position. Salvage is per field, so one bad value
 * never costs the rest of the record.
 *
 * @example
 * normalizeOnboardingState({ welcomeAcknowledged: true, skippedSteps: ['gone'] });
 * // => { welcomeAcknowledged: true, skippedSteps: [] }
 */
export function normalizeOnboardingState(value: unknown): OnboardingState {
  if (!isRecord(value)) return DEFAULT_ONBOARDING_STATE;

  const completedAt =
    typeof value.completedAt === 'number' && Number.isFinite(value.completedAt)
      ? Math.max(0, Math.trunc(value.completedAt))
      : undefined;
  const skipped = Array.isArray(value.skippedSteps) ? value.skippedSteps : [];
  const environmentId = boundedString(value.environmentId, ID_MAX_LENGTH);
  const workdir = boundedString(value.workdir, WORKDIR_MAX_LENGTH);
  const chatId = boundedString(value.chatId, ID_MAX_LENGTH);
  const runner = runnerOf(value.runner);

  return {
    ...(completedAt === undefined ? {} : { completedAt }),
    welcomeAcknowledged: value.welcomeAcknowledged === true,
    // Filtered through the canonical order rather than the client's, so the
    // array is deduplicated and two clients that skipped the same steps in a
    // different sequence persist the same value.
    skippedSteps: ONBOARDING_STEP_IDS.filter((step) =>
      skipped.some((candidate) => isOnboardingStepId(candidate) && candidate === step)
    ),
    ...(environmentId === undefined ? {} : { environmentId }),
    ...(workdir === undefined ? {} : { workdir }),
    ...(runner === undefined ? {} : { runner }),
    ...(chatId === undefined ? {} : { chatId }),
  };
}

/** True once the flow finished or was skipped whole. // Usage: if (isOnboardingComplete(state)) return; */
export function isOnboardingComplete(state: OnboardingState): boolean {
  return state.completedAt !== undefined;
}
