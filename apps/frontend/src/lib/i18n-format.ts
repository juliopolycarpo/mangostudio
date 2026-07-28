/**
 * Placeholder substitution for message templates.
 *
 * Shared by every feature that renders a `{name}` template, so a template and
 * the function that fills it in stay one contract instead of one copy per
 * feature drifting apart.
 */

/**
 * Substitutes `{key}` placeholders in a template. Unknown placeholders are left
 * untouched so a template that outruns its caller degrades to something
 * readable instead of rendering `undefined`.
 *
 * // Usage: formatMessage(t.library.matrix.selectRow, { resource: 'gh' })
 */
export function formatMessage(template: string, params: Record<string, string> = {}): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => params[key] ?? match);
}
