/**
 * @deprecated This module has been merged into services/providers/gemini/.
 * Re-exporting for backward compatibility with legacy import paths.
 */
export * from '../providers/gemini/text';
// Legacy aliases: old exports used generateText / generateTextStream names
export {
  generateGeminiText as generateText,
  generateGeminiTextStream as generateTextStream,
} from '../providers/gemini/text';
