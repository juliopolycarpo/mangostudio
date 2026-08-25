import type { ToolExecutionStatus } from '@mangostudio/shared/tool-executions';
import {
  AlertCircle,
  ArrowRightLeft,
  Ban,
  Check,
  Clock,
  FileDiff,
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
  TimerOff,
  Trash2,
  UserRound,
  Wrench,
} from 'lucide-react';
import type { TimelineTone } from './TimelineItem';

/**
 * Maps a lifecycle status onto the timeline's node colour, which is also the
 * colour the tool's own name is printed in — the rail and the label always
 * agree about how a step ended.
 *
 * // Usage: toolStatusTone('failed') // => 'error'
 */
export function toolStatusTone(status: ToolExecutionStatus): TimelineTone {
  switch (status) {
    case 'succeeded':
      return 'success';
    case 'failed':
    case 'timed_out':
      return 'error';
    case 'cancelled':
      return 'muted';
    default:
      return 'active';
  }
}

const TONE_TEXT_CLASS: Record<TimelineTone, string> = {
  neutral: 'text-on-surface',
  muted: 'text-on-surface-variant/70',
  active: 'text-primary',
  success: 'text-success',
  error: 'text-error',
};

/**
 * Text colour for a timeline tone, used for the tool name itself.
 *
 * // Usage: toneTextClass('success') // => 'text-success'
 */
export function toneTextClass(tone: TimelineTone): string {
  return TONE_TEXT_CLASS[tone];
}

/**
 * Formats a monotonic duration for a timeline row, e.g. `640ms` or `2.4s`.
 *
 * // Usage: formatToolDuration(640) // => '640ms'
 */
export function formatToolDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.max(0, Math.round(durationMs))}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

/**
 * The status glyph every tool row draws. Terminal states get a verdict mark; a
 * call still in flight gets its own tool icon, which is the only place tool
 * identity is drawn — a settled row is identified by its name alone.
 *
 * Lives here rather than in either block because a collapsed group and the
 * calls inside it sit on the same rail: two glyph tables would let the run's
 * verdict mark drift from its members'.
 *
 * // Usage: <StatusGlyph status="failed" name="grep" />
 */
export function StatusGlyph({ status, name }: { status: ToolExecutionStatus; name: string }) {
  switch (status) {
    case 'succeeded':
      return <Check size={12} className="shrink-0" strokeWidth={2.5} />;
    case 'failed':
      return <AlertCircle size={11} className="shrink-0" />;
    case 'timed_out':
      return <TimerOff size={11} className="shrink-0" />;
    case 'cancelled':
      return <Ban size={11} className="shrink-0" />;
    case 'awaiting_user':
      return <UserRound size={11} className="shrink-0" />;
    default:
      return <ToolIcon toolName={name} className="animate-pulse shrink-0" />;
  }
}

/**
 * Renders a per-tool icon based on the tool name.
 * Falls back to the generic Wrench icon for unknown tools.
 *
 * Internal: the status glyph is the only thing that draws tool identity, and it
 * lives in this module.
 *
 * // Usage: <ToolIcon toolName="read_file" className="shrink-0" />
 */
function ToolIcon({ toolName, className }: { toolName: string; className?: string }) {
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
    case 'apply_patch':
      return <FileDiff size={size} className={className} />;
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
export function getToolHint(
  toolName: string,
  args: Record<string, unknown>,
  formatAdditionalCount: (count: number) => string = (count) => `+${count} more`
): string | null {
  switch (toolName) {
    case 'read_file': {
      // A byte view returns something entirely unlike file content, so the hint
      // carries it: two calls on one path are otherwise indistinguishable here.
      const path = abbreviatePath(args.path);
      if (!path) return null;
      const view = args.view;
      return typeof view === 'string' && view !== 'text' ? `${path} (${view})` : path;
    }
    case 'list_directory':
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
    case 'apply_patch':
      return getPatchHint(args.patch, formatAdditionalCount);
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
    // Shown verbatim: the API searches the regular expression as given, so
    // trimming here would advertise a different pattern than the one that ran.
    case 'grep':
      return typeof args.pattern === 'string' && args.pattern.length > 0 ? args.pattern : null;
    case 'glob':
      return typeof args.pattern === 'string' && args.pattern.trim().length > 0
        ? args.pattern.trim()
        : null;
    default:
      return null;
  }
}

/**
 * Extracts only file-operation headers for a cheap, non-throwing patch summary.
 * The backend parser remains authoritative; chat rendering must tolerate a
 * partial argument stream while a tool call is still being assembled.
 */
function getPatchHint(
  patch: unknown,
  formatAdditionalCount: (count: number) => string
): string | null {
  if (typeof patch !== 'string') return null;
  const paths = Array.from(
    patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File:[ \t]*([^\r\n]+?)[ \t]*$/gm),
    (match) => match[1]
  ).filter((path): path is string => typeof path === 'string' && path.length > 0);
  const first = abbreviatePath(paths[0]);
  if (!first) return null;
  const additionalCount = paths.length - 1;
  return additionalCount > 0 ? `${first} (${formatAdditionalCount(additionalCount)})` : first;
}
