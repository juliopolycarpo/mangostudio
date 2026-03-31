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
  /-image-/, // Generic convention (e.g. gemini-2.0-flash-image-*)
  /^stable-diffusion/, // Stability AI (common in compatible providers)
  /^sdxl/, // SDXL variants
];

/** Returns true when `modelId` matches any known image-generation model pattern. */
export function isImageModelId(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return IMAGE_MODEL_PATTERNS.some((pattern) => pattern.test(id));
}
