/**
 * Centralized image-model detection.
 *
 * Instead of scattering `startsWith('dall-e')` checks across providers,
 * all known image-model naming patterns live here. To support a new family
 * of image models, add a single RegExp entry to IMAGE_MODEL_PATTERNS.
 */

const IMAGE_MODEL_PATTERNS: RegExp[] = [
  /^dall-e/, // OpenAI DALL-E 2 / 3
  /^gpt-image/, // OpenAI GPT-Image-1+
  /imagen-/, // Google Imagen family
  /-image/, // Generic convention (e.g. gemini-2.5-flash-image, gemini-2.0-flash-image-*)
  /^stable-diffusion/, // Stability AI (common in compatible providers)
  /^sdxl/, // SDXL variants
];

/** Returns true when `modelId` matches any known image-generation model pattern. */
export function isImageModelId(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return IMAGE_MODEL_PATTERNS.some((pattern) => pattern.test(id));
}

/**
 * Reasoning-capable model families.
 * Covers: o1/o3/o4-series, gpt-5.x, Claude 3.5 Sonnet+, Gemini 2.5, DeepSeek R1/Reasoner.
 */
const REASONING_MODEL_PATTERNS: RegExp[] = [
  /^o[1-9]/, // OpenAI o-series
  /^gpt-5/, // OpenAI GPT-5 family
  /^claude-3-5-sonnet/, // Anthropic Claude 3.5 Sonnet (extended thinking)
  /^claude-sonnet-4/, // Anthropic Claude Sonnet 4+
  /^claude-opus-4/, // Anthropic Claude Opus 4+
  /^gemini-2\.5/, // Google Gemini 2.5 (thinking models)
  /^deepseek-r1/, // DeepSeek R1
  /^deepseek-reasoner/, // DeepSeek Reasoner
];

/** Returns true when `modelId` matches a known reasoning-capable model family. */
export function isReasoningModel(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return REASONING_MODEL_PATTERNS.some((pattern) => pattern.test(id));
}
