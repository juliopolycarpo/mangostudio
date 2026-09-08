import Type, { type Static } from 'typebox';
import { ChatRunnerConfigurationSchema } from '../chat/schemas';

/**
 * The first-run flow, in order. A step is a question the person answers once,
 * not a screen: `folder` asks where work happens, `chat` asks the agent to
 * answer. Order matters — resume walks this list and stops at the first step
 * the machine cannot already satisfy.
 */
export const ONBOARDING_STEP_IDS = [
  'welcome',
  'folder',
  'toolchain',
  'agents',
  'service',
  'chat',
] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number];

export const OnboardingStepIdSchema = Type.Union([
  Type.Literal('welcome'),
  Type.Literal('folder'),
  Type.Literal('toolchain'),
  Type.Literal('agents'),
  Type.Literal('service'),
  Type.Literal('chat'),
]);

/** Bounds a persisted path so a malformed client cannot grow the settings row without limit. */
const WORKDIR_MAX_LENGTH = 4096;
const ID_MAX_LENGTH = 128;

/**
 * What the wizard remembers between visits.
 *
 * Everything here is either a *choice the person made* or a *fact only they can
 * supply*. Nothing derivable from the machine is stored: whether a toolchain is
 * installed, an agent is signed in, or the hub service is running is read live
 * on every resume, so a machine that changed underneath the user sends them
 * back to the step that changed rather than to a remembered lie.
 *
 * `welcomeAcknowledged` is the exception that proves the rule — no machine fact
 * can say whether someone has read the welcome step, so it carries its own bit.
 */
export const OnboardingStateSchema = Type.Object({
  /** Set once the flow is finished or fully skipped. Absent means "not done". */
  completedAt: Type.Optional(Type.Integer({ minimum: 0 })),
  welcomeAcknowledged: Type.Boolean(),
  skippedSteps: Type.Array(OnboardingStepIdSchema, { maxItems: ONBOARDING_STEP_IDS.length }),
  /** The machine every later step acts on, chosen before the folder is browsed. */
  environmentId: Type.Optional(Type.String({ minLength: 1, maxLength: ID_MAX_LENGTH })),
  workdir: Type.Optional(Type.String({ minLength: 1, maxLength: WORKDIR_MAX_LENGTH })),
  runner: Type.Optional(ChatRunnerConfigurationSchema),
  /** The chat the flow created, so a reload reopens it instead of creating a second one. */
  chatId: Type.Optional(Type.String({ minLength: 1, maxLength: ID_MAX_LENGTH })),
});

export type OnboardingState = Static<typeof OnboardingStateSchema>;
