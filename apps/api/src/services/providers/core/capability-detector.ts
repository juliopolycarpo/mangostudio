/**
 * Model capability detection helpers.
 *
 * Centralises the regex-based and name-based patterns used across provider
 * adapters so each adapter does not duplicate the same detection logic.
 * Delegates to the shared model-detection utilities in @mangostudio/shared.
 */

export { isImageModelId, isReasoningModel } from '@mangostudio/shared/utils/model-detection';
