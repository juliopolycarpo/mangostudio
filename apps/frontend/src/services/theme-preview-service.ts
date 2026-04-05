import { highlightCode, loadThemeOnDemand, type CodeThemeId } from '@/lib/shiki';

const PREVIEW_CODE = `const greeting = "hello";
function greet(name) {
  return \`\${greeting}, \${name}\`;
}`;

const previewCache = new Map<CodeThemeId, string>();

export async function getThemePreview(themeId: CodeThemeId): Promise<string | null> {
  if (previewCache.has(themeId)) return previewCache.get(themeId)!;

  // Load without persisting — previews should not mark a theme as installed.
  const loaded = await loadThemeOnDemand(themeId, { persist: false });
  if (!loaded) return null;

  const html = highlightCode(PREVIEW_CODE, 'typescript', themeId);
  if (html) previewCache.set(themeId, html);
  return html;
}

export function getCachedPreview(themeId: CodeThemeId): string | null {
  return previewCache.get(themeId) ?? null;
}

export function clearPreviewCache() {
  previewCache.clear();
}
