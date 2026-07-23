import {
  ArrowRightLeft,
  Clock,
  FileEdit,
  FilePenLine,
  FilePlus,
  FileSearch,
  FileText,
  FolderOpen,
  ImagePlus,
  Replace,
  Search,
  Terminal,
  Trash2,
  Wrench,
} from 'lucide-react';

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
    case 'write_file':
      return <FileEdit size={size} className={className} />;
    case 'edit_file':
      return <FilePenLine size={size} className={className} />;
    case 'replace_range':
      return <Replace size={size} className={className} />;
    case 'create_file':
      return <FilePlus size={size} className={className} />;
    case 'delete_file':
      return <Trash2 size={size} className={className} />;
    case 'move_file':
      return <ArrowRightLeft size={size} className={className} />;
    case 'generate_image':
      return <ImagePlus size={size} className={className} />;
    case 'get_current_datetime':
      return <Clock size={size} className={className} />;
    case 'bash':
    case 'zsh':
    case 'powershell':
      return <Terminal size={size} className={className} />;
    case 'grep':
      return <Search size={size} className={className} />;
    case 'glob':
      return <FileSearch size={size} className={className} />;
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
function abbreviatePath(rawPath: unknown): string | null {
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
    case 'write_file':
    case 'edit_file':
    case 'create_file':
    case 'delete_file':
      return abbreviatePath(args.path);
    case 'replace_range': {
      // The line range is what distinguishes one range edit from the next, so it
      // rides along with the path instead of collapsing every call to one hint.
      const path = abbreviatePath(args.path);
      if (!path) return null;
      const { startLine, endLine } = args;
      if (typeof startLine !== 'number' || typeof endLine !== 'number') return path;
      return `${path}:${startLine}-${endLine}`;
    }
    case 'move_file': {
      const from = abbreviatePath(args.from);
      const to = abbreviatePath(args.to);
      return from && to ? `${from} → ${to}` : null;
    }
    case 'bash':
    case 'zsh':
    case 'powershell':
      return typeof args.command === 'string' && args.command.trim().length > 0
        ? args.command.trim()
        : null;
    case 'grep':
    case 'glob':
      return typeof args.pattern === 'string' && args.pattern.trim().length > 0
        ? args.pattern.trim()
        : null;
    default:
      return null;
  }
}
