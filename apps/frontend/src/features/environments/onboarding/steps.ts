/**
 * The onboarding flow's shape, and where re-entering it resumes.
 *
 * There are no wizard tables and no session rows. The environment row is the
 * only anchor, and every step is idempotent upstream — a digest-gated push, a
 * re-runnable `setup`, a converging `service install` — so "resume" is just
 * "work out the first unfinished step and carry on". Abandoning the flow leaves
 * a valid, partly configured environment with its card's normal actions, never
 * a wedged intermediate.
 *
 * Kept free of React so the derivation can be read, and tested, as the decision
 * table it is.
 */

import type { EnvironmentTransportKind } from '@mangostudio/shared/environments';
import type { RuntimeHealthReport } from '@mangostudio/shared/runtime-home';

/**
 * How the hub will reach this machine once onboarding is done. The one real
 * decision in the flow: everything else follows from it.
 */
export type OnboardingEndState =
  /** The hub dials over ssh each time. Simple, nothing to supervise. */
  | 'ssh'
  /** The machine dials the hub, so it survives the hub changing networks. */
  | 'paired';

export type OnboardingStepId =
  | 'reach'
  | 'end-state'
  | 'install'
  | 'permissions'
  | 'provision'
  | 'tools'
  | 'library'
  | 'done';

/**
 * The two paths differ in the middle, and pretending otherwise would be a lie
 * the progress rail tells. An ssh environment installs and consents as two
 * separate hub actions against a stored config; a paired one has no stored
 * config to act against, so its provisioning is a single run over a channel
 * that exists only for the length of it.
 */
const SSH_STEPS: readonly OnboardingStepId[] = [
  'reach',
  'end-state',
  'install',
  'permissions',
  'tools',
  'library',
  'done',
];

const PAIRED_STEPS: readonly OnboardingStepId[] = [
  'reach',
  'end-state',
  'permissions',
  'provision',
  'tools',
  'library',
  'done',
];

export function onboardingSteps(endState: OnboardingEndState): readonly OnboardingStepId[] {
  return endState === 'paired' ? PAIRED_STEPS : SSH_STEPS;
}

export interface OnboardingProgress {
  readonly transportKind: EnvironmentTransportKind;
  readonly connected: boolean;
  /** The last `runtime.health` the hub saw; null when it has never seen one. */
  readonly health: RuntimeHealthReport | null;
  /** Whether anything has been probed on this machine yet. */
  readonly probed: boolean;
}

/**
 * The first step that still has work in it, for an environment the flow
 * already created.
 *
 * Everything here is read from data that exists anyway — the lifecycle view's
 * health, the connection state, the probe cache — which is what makes resume
 * free of stored wizard state.
 *
 * A paired environment that is not connected restarts at the ssh form on
 * purpose. The hub keeps no ssh credentials for a machine it reaches over a
 * socket, so it cannot pick up where it left off without being handed them
 * again; asking is the honest cost of not storing them.
 */
export function deriveOnboardingStep(progress: OnboardingProgress): OnboardingStepId {
  if (progress.transportKind === 'websocket') {
    if (!progress.connected) return 'reach';
    return progress.probed ? 'library' : 'tools';
  }

  // A machine with no health has nothing installed the hub has ever spoken to.
  if (!progress.health) return 'install';
  if (progress.health.setup.state === 'pending') return 'permissions';
  return progress.probed ? 'library' : 'tools';
}

/**
 * Which end state an existing row implies. Used when the flow is re-entered
 * against an environment rather than started from the picker.
 */
export function endStateOf(transportKind: EnvironmentTransportKind): OnboardingEndState {
  return transportKind === 'websocket' ? 'paired' : 'ssh';
}
