import { Clock, FileText, FolderOpen, ImagePlus, Terminal, Wrench } from 'lucide-react';

/**
 * Renders a per-tool icon based on the tool name.
 * Falls back to the generic Wrench icon for unknown tools.
 *
 * // Usage: <ToolIcon toolName="read_file" className="shrink-0" />
 */
export function ToolIcon({ toolName, className }: { toolName: string; className?: string }) {
  const size = 11;
  switch (toolName) {
    case 'list_directory':
      return <FolderOpen size={size} className={className} />;
    case 'read_file':
      return <FileText size={size} className={className} />;
    case 'generate_image':
      return <ImagePlus size={size} className={className} />;
    case 'get_current_datetime':
      return <Clock size={size} className={className} />;
    case 'bash':
    case 'zsh':
    case 'powershell':
      return <Terminal size={size} className={className} />;
    default:
      return <Wrench size={size} className={className} />;
  }
}

/**
 * Abbreviates a path for inline display next to the tool label.
 * Replaces the home directory prefix with `~` and keeps it short.
 *
 * // Usage: abbreviatePath('/home/ada/notes.md') // => '~/notes.md'
 */
export function abbreviatePath(rawPath: unknown): string | null {
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) return null;
  let p = rawPath.trim();
  const homeMatch = p.match(/^\/home\/[^/]+/);
  if (homeMatch) p = `~${p.slice(homeMatch[0].length)}`;
  return p;
}

/**
 * Produces an optional inline hint string that follows the label.
 * Filesystem tools show the path; shell tools show the command; others none.
 *
 * // Usage: getToolHint('read_file', { path: '/home/ada/notes.md' }) // => '~/notes.md'
 */
export function getToolHint(toolName: string, args: Record<string, unknown>): string | null {
  switch (toolName) {
    case 'list_directory':
    case 'read_file':
      return abbreviatePath(args.path);
    case 'bash':
    case 'zsh':
    case 'powershell':
      return typeof args.command === 'string' && args.command.trim().length > 0
        ? args.command.trim()
        : null;
    default:
      return null;
  }
}
