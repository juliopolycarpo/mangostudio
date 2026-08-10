/**
 * What this adapter was written against, and what a live `claude` must be for
 * it to apply.
 *
 * The programmatic surface is Anthropic's own: `claude --print --output-format
 * stream-json` is documented as the headless interface, including a section on
 * adding Claude to a build script, `parent_tool_use_id` reconstruction for an
 * external consumer, and defined SIGTERM behaviour for an SDK host closing the
 * session. MangoStudio is that host, so nothing here has to argue that driving
 * the CLI programmatically is intended.
 */

/**
 * The oldest `claude` this adapter will drive.
 *
 * Not 2.1.200. That is the floor for the `manual` alias alone, and this adapter
 * also passes `--forward-subagent-text`, which arrived in **2.1.211**. Pinning
 * the lower number would produce a descriptor that looks selectable and a turn
 * that fails on an unknown flag.
 *
 * Two later builds change behaviour without changing what this adapter may
 * pass, so they are recorded here rather than gated on:
 *
 * - **2.1.219** is where subagent text stops being flat. Below it,
 *   `--forward-subagent-text` emits one level, so a nested subagent's output is
 *   attributed to the wrong parent or dropped. A partially nested transcript is
 *   still worth running.
 * - **2.1.223** is where `--resume` stops being scoped to the project directory
 *   the session was created in. The adapter passes the same `cwd` on resume
 *   either way, which is why the working directory is not a free variable
 *   between turns.
 */
export const MINIMUM_CLAUDE_VERSION = '2.1.211' as const;

/** The command that signs a user in, shown with a copy button when signed out. */
export const CLAUDE_LOGIN_COMMAND = 'claude auth login' as const;

/**
 * Documented Claude variables the child is allowed to inherit.
 *
 * `CLAUDE_CONFIG_DIR` relocates the whole configuration and credential home, so
 * without it a user who moved it would appear signed out.
 * `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` is the vendor's own ceiling on how
 * long a finished turn waits for background subagents; an operator who lowered
 * it means it, and dropping the variable would silently restore the ten-minute
 * default. The base allowlist in `process.ts` supplies everything else, and
 * nothing a hub request carries can add to this list.
 */
export const CLAUDE_VENDOR_ENVIRONMENT_KEYS = [
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS',
] as const;

/**
 * Exit code the CLI uses for a turn stopped by SIGTERM.
 *
 * 128 + SIGTERM. The supervisor must read it as a clean cancel: a cancelled
 * turn that reports an error would put a failure in the transcript for
 * something the user asked for.
 */
export const CLAUDE_SIGTERM_EXIT_CODE = 143;

/**
 * How long a turn's process is given to exit after its `result` record.
 *
 * Not zero, and not the turn budget. Background subagents hold the process open
 * after the result — up to a ten-minute vendor default — so the stream ending
 * is what marks the turn done, and this only bounds how long the adapter waits
 * for the process to follow before it stops being polite about it.
 */
export const CLAUDE_POST_RESULT_GRACE_MS = 2_000;

/**
 * Where administrator-managed settings live, per platform.
 *
 * Read directly, because `disableAutoMode` has to be known *before* a mode is
 * chosen. Inferring it from a failed run cannot work: `--permission-mode auto`
 * being rejected at startup is indistinguishable from any other startup
 * failure, and guessing wrong means passing a mode the user's organization
 * deliberately turned off.
 *
 * `%PROGRAMDATA%` is read rather than hard-coded because the directory is
 * relocatable, and the failure is silent and unsafe: an unreadable path is
 * caught, reads as "no policy", and leaves `auto` available for the adapter to
 * pass to a CLI whose administrator disabled it.
 */
export function claudeManagedSettingsPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json';
  if (platform === 'win32') {
    const programData = env.PROGRAMDATA ?? env.ProgramData ?? 'C:\\ProgramData';
    return `${programData}\\ClaudeCode\\managed-settings.json`;
  }
  return '/etc/claude-code/managed-settings.json';
}
