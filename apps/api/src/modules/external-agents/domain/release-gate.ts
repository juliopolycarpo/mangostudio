/**
 * The availability gate.
 *
 * Hosting an external turn arrives in stages, across several pull requests,
 * and the first usable one only exists at the end. Until then a
 * selectable external runner could start a turn and then block on an approval
 * nobody can answer, so discovery reports every target as unavailable and the
 * selector has nothing to offer.
 *
 * `main` stays releasable throughout, and lifting the gate is deleting this
 * file and its single call site — a reviewable diff rather than a promise.
 */

/** True while no external agent can complete a turn. Deleted when one can. */
export const EXTERNAL_AGENTS_NOT_YET_AVAILABLE = true;
