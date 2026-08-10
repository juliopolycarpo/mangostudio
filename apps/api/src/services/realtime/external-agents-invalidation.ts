import { EXTERNAL_AGENTS_TOPIC } from '@mangostudio/shared/realtime';
import { getRealtimeBus } from './realtime-bus';

/**
 * Publishes one user-scoped refresh after a background discovery probe produced
 * a better answer than the one already served.
 *
 * Deliberately not `publishEnvironmentInvalidation`, and deliberately not paired
 * with an in-process hook of its own. That function also runs the environment
 * invalidation listeners, one of which drops the external-agent discovery cache
 * — so a probe announcing its own result through it would reset the entry it had
 * just written, and the refetch it asked for would miss, probe, publish and
 * reset again. Single-flight and the per-environment cap collapse a *burst* into
 * one probe; neither stops a self-sustaining cycle of sequential ones.
 *
 * The distinction this topic encodes is real: the environment did not change
 * here, only what the hub knows about it did.
 */
export function publishExternalAgentsInvalidation(userId: string): void {
  if (userId.length === 0) return;
  getRealtimeBus().publish(userId, {
    type: 'invalidate',
    topic: EXTERNAL_AGENTS_TOPIC,
  });
}
