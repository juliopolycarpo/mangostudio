/**
 * @deprecated Use model-utils.ts instead. This file re-exports for backward compatibility.
 */
export {
  EMPTY_MODEL_CATALOG as EMPTY_GEMINI_MODEL_CATALOG,
  hasModelOption,
  resolveSelectedModel,
  resolveActiveModeModel,
  getModelSelectorPlaceholder,
} from './model-utils';

export type { ModelOption as GeminiModelOption } from '@mangostudio/shared';
