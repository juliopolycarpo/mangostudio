/**
 * The one reason a planned image carries when its turn was interrupted.
 *
 * A single Stop can end an image three ways — one already in flight with the
 * provider, one the generator never reached, and one a crash left behind — and
 * the user made one gesture, so all three have to read the same. Kept in a leaf
 * module because the producers span layers: the `generate_image` tool builds the
 * outcome, `stream-text-turn-helpers` streams it, and `turn-recovery` seals it on
 * reload. Living in `turn-recovery` would drag Kysely and the message
 * repositories into a builtin tool.
 */

import type { ImageGenerationErrorCode } from '@mangostudio/shared/generation';

/** What a planned image records when the turn ended before it was generated. */
export const IMAGE_ABANDONED_ERROR = 'The turn was interrupted before this image was generated.';

/**
 * The renderable counterpart of {@link IMAGE_ABANDONED_ERROR}.
 *
 * `IMAGE_ABANDONED_ERROR` also travels as the tool result a model reads, so it
 * stays in English; this code is what a UI switches on to show the user's own
 * language instead.
 */
export const IMAGE_ABANDONED_ERROR_CODE: ImageGenerationErrorCode = 'image_generation_interrupted';
