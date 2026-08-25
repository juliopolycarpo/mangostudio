import Type, { type Static } from 'typebox';
import { ChatRunnerConfigurationSchema } from '../chat/schemas';
import { EnvironmentConnectionStateSchema } from '../environments/schemas';
import { ExternalAgentTargetIdSchema } from '../external-agents/schemas';
import { LibraryTargetIdSchema, ResourceKindSchema } from '../library/schemas';
import { ReadonlyArraySchema } from '../schema-helpers';

/**
 * What the hub considers worth remembering about a session it is not showing.
 *
 * Closed on purpose and deliberately small. An event earns a kind when a user
 * returning after an hour would want it on the "what changed" list; a reading
 * that a live card already shows (current quota, current faults) does not —
 * only its *transition* does, which is why `quota_refreshed` and
 * `environment_health_changed` carry both endpoints of a change rather than a
 * snapshot.
 */
export const ActivityEventKindSchema = Type.Union([
  Type.Literal('chat_created'),
  Type.Literal('turn_completed'),
  Type.Literal('commit_created'),
  Type.Literal('branch_pushed'),
  Type.Literal('propagation_applied'),
  Type.Literal('quota_refreshed'),
  Type.Literal('environment_health_changed'),
]);

export type ActivityEventKind = Static<typeof ActivityEventKindSchema>;

/**
 * Scoping columns every event carries, indexed rather than buried in `payload`
 * so the feed can filter on them.
 *
 * `null` means "not applicable to this kind", never "unknown": a commit always
 * has a workdir, a propagation never has a chat.
 */
const activityScopeFields = {
  id: Type.String({ minLength: 1 }),
  /** Epoch milliseconds, matching every other timestamp on the wire. */
  createdAt: Type.Number(),
  chatId: Type.Union([Type.String(), Type.Null()]),
  workdir: Type.Union([Type.String(), Type.Null()]),
  environmentId: Type.Union([Type.String(), Type.Null()]),
  targetId: Type.Union([Type.String(), Type.Null()]),
};

const ChatCreatedActivitySchema = Type.Object({
  ...activityScopeFields,
  kind: Type.Literal('chat_created'),
  payload: Type.Object({
    title: Type.String(),
  }),
});

const TurnCompletedActivitySchema = Type.Object({
  ...activityScopeFields,
  kind: Type.Literal('turn_completed'),
  payload: Type.Object({
    title: Type.String(),
    /** Who ran it, so the feed can badge the vendor without reading the chat back. */
    runner: ChatRunnerConfigurationSchema,
  }),
});

const CommitCreatedActivitySchema = Type.Object({
  ...activityScopeFields,
  kind: Type.Literal('commit_created'),
  payload: Type.Object({
    subject: Type.String(),
    /** Absent when the commit succeeded but the branch could not be read back. */
    branch: Type.Union([Type.String(), Type.Null()]),
  }),
});

const BranchPushedActivitySchema = Type.Object({
  ...activityScopeFields,
  kind: Type.Literal('branch_pushed'),
  payload: Type.Object({
    branch: Type.String(),
    remote: Type.String(),
  }),
});

const PropagationAppliedActivitySchema = Type.Object({
  ...activityScopeFields,
  kind: Type.Literal('propagation_applied'),
  payload: Type.Object({
    resourceKind: ResourceKindSchema,
    resourceName: Type.String(),
    /** The agents the resource was written to, in the order the apply reported them. */
    targets: ReadonlyArraySchema(LibraryTargetIdSchema, { maxItems: 16 }),
  }),
});

const QuotaRefreshedActivitySchema = Type.Object({
  ...activityScopeFields,
  kind: Type.Literal('quota_refreshed'),
  payload: Type.Object({
    target: ExternalAgentTargetIdSchema,
    /**
     * Both endpoints of the primary window's consumption, so the feed can say
     * "62% → 71%" without holding a history of readings. Recorded only when the
     * move is large enough to be worth a row (see `QUOTA_ACTIVITY_DELTA_POINTS`).
     */
    previousUsedPercent: Type.Number(),
    usedPercent: Type.Number(),
  }),
});

const EnvironmentHealthChangedActivitySchema = Type.Object({
  ...activityScopeFields,
  kind: Type.Literal('environment_health_changed'),
  payload: Type.Object({
    environmentName: Type.String(),
    /**
     * Settled states only. `connecting` is a step, not an outcome — recording it
     * would put two rows in the feed for every reconnect and neither would say
     * anything the next one does not.
     */
    previousState: EnvironmentConnectionStateSchema,
    state: EnvironmentConnectionStateSchema,
  }),
});

export const ActivityEventSchema = Type.Union([
  ChatCreatedActivitySchema,
  TurnCompletedActivitySchema,
  CommitCreatedActivitySchema,
  BranchPushedActivitySchema,
  PropagationAppliedActivitySchema,
  QuotaRefreshedActivitySchema,
  EnvironmentHealthChangedActivitySchema,
]);

export type ActivityEvent = Static<typeof ActivityEventSchema>;

/**
 * How far the primary quota window must move before a refresh is worth a row.
 *
 * A refresh runs after most turns, so recording every reading would drown the
 * feed in noise the `AgentsCard` already shows live. Five points is roughly one
 * heavy turn on a weekly window, and a window *reset* is a large negative move,
 * so both directions clear it.
 */
export const QUOTA_ACTIVITY_DELTA_POINTS = 5;

export const ACTIVITY_PAGE_LIMIT_DEFAULT = 30;
export const ACTIVITY_PAGE_LIMIT_MAX = 100;

/**
 * `cursor` is the opaque keyset token from the previous page's `nextCursor`.
 * Opaque because it encodes `(createdAt, id)`: two events can share a
 * millisecond, and an offset cursor would skip or repeat rows as new events
 * land at the head between pages.
 */
export const ListActivityQuerySchema = Type.Object({
  /** Epoch milliseconds, exclusive. Narrows the feed to "since your last visit". */
  since: Type.Optional(Type.Integer({ minimum: 0 })),
  workdir: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: ACTIVITY_PAGE_LIMIT_MAX,
      default: ACTIVITY_PAGE_LIMIT_DEFAULT,
    })
  ),
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
});

export type ListActivityQuery = Static<typeof ListActivityQuerySchema>;

export const ListActivityResponseSchema = Type.Object({
  events: ReadonlyArraySchema(ActivityEventSchema, { maxItems: ACTIVITY_PAGE_LIMIT_MAX }),
  /** Absent on the last page. */
  nextCursor: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
});

export type ListActivityResponse = Static<typeof ListActivityResponseSchema>;
