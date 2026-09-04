/**
 * A `claude --help` excerpt, kept in the shape commander actually prints.
 *
 * Trimmed to the options the adapter reads plus enough neighbours to exercise
 * the parser's real problems: a description that *mentions* a flag it does not
 * declare, an option whose flags wrap onto their own line, and a choice list
 * long enough that commander wraps it mid-list. A hand-tidied fixture with one
 * option per line would pass a parser that cannot read the vendor's output.
 *
 * Captured from `claude --version` 2.1.227 on 2026-08-11. The committed
 * contract under `src/services/external-agents/claude/contract/` is what tracks
 * the real surface over time; this is a fixture for the parser, so it is
 * allowed to be a subset.
 */
export const CLAUDE_HELP_TEXT = `Usage: claude [options] [command] [prompt]

Claude Code - starts an interactive session by default, use -p/--print for
non-interactive output

Arguments:
  prompt                                Your prompt

Options:
  --add-dir <directories...>            Additional directories to allow tool
                                        access to
  --allowedTools, --allowed-tools <tools...>
      Comma or space-separated list of tool names to allow (e.g. "Bash(git *)
      Edit")
  --forward-subagent-text               Forward subagent text and thinking
                                        blocks as assistant/user messages with
                                        parent_tool_use_id set (only works with
                                        --print and --output-format=stream-json)
  --include-partial-messages            Include partial message chunks as they
                                        arrive (only works with --print and
                                        --output-format=stream-json)
  --input-format <format>               Input format (only works with --print):
                                        "text" (default), or "stream-json"
                                        (realtime streaming input) (choices:
                                        "text", "stream-json")
  --model <model>                       Model for the current session.
  --output-format <format>              Output format (only works with --print):
                                        "text" (default), "json" (single
                                        result), or "stream-json" (realtime
                                        streaming) (choices: "text", "json",
                                        "stream-json")
  --permission-mode <mode>              Permission mode to use for the session
                                        (choices: "acceptEdits", "auto",
                                        "bypassPermissions", "manual",
                                        "dontAsk", "plan")
  -p, --print                           Print response and exit (useful for
                                        pipes).
  -r, --resume [sessionId]              Resume a conversation.
  --session-id <uuid>                   Use a specific session ID for the
                                        conversation (must be a valid UUID)
  -v, --version                         Output the version number
  --verbose                             Override verbose mode setting from
                                        config

Commands:
  auth <subcommand>                     Manage authentication
  mcp                                   Configure and manage MCP servers
`;

/** The same text as the line array a scripted process hands back. */
export const CLAUDE_HELP_LINES: readonly string[] = CLAUDE_HELP_TEXT.split('\n');

/**
 * The same excerpt from 2.1.260, kept *beside* the 2.1.227 one rather than
 * replacing it.
 *
 * Two fixtures because the interesting behaviour is the difference between
 * them, and a single regenerated fixture would delete the older half of every
 * such pair:
 *
 * - `--model` gained the alias prose. On 2.1.227 the line is the bare "Model
 *   for the current session.", which is what proves an absent catalog stays
 *   absent instead of becoming an empty one.
 * - `--effort` and `--permission-prompts` did not exist at all on 2.1.227,
 *   which is what proves an older build keeps working with the new features
 *   simply off.
 *
 * Captured from `claude --version` 2.1.260 on 2026-09-04. Two traps in
 * `--model`'s prose are reproduced exactly and must not be tidied: the alias
 * list and the *full name* example live in two different `(e.g. …)` groups, and
 * the apostrophe in "model's" opens a quote that a naive scan closes against
 * the next one.
 */
export const CLAUDE_HELP_TEXT_2_1_260 = `Usage: claude [options] [command] [prompt]

Claude Code - starts an interactive session by default, use -p/--print for
non-interactive output

Arguments:
  prompt                                Your prompt

Options:
  --add-dir <directories...>            Additional directories to allow tool
                                        access to
  --disallowedTools, --disallowed-tools <tools...>
      Comma or space-separated list of tool names to deny (e.g. "Bash(git *)
      Edit")
  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --environment <environment_id>        Create a new cloud session that runs on
                                        the given self-hosted environment
                                        (ccpool_...).
  --forward-subagent-text               Forward subagent text and thinking
                                        blocks as assistant/user messages with
                                        parent_tool_use_id set (only works with
                                        --print and --output-format=stream-json)
  --include-partial-messages            Include partial message chunks as they
                                        arrive (only works with --print and
                                        --output-format=stream-json)
  --input-format <format>               Input format (only works with --print):
                                        "text" (default), or "stream-json"
                                        (realtime streaming input) (choices:
                                        "text", "stream-json")
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name (e.g.
                                        'claude-fable-5').
  --output-format <format>              Output format (only works with --print):
                                        "text" (default), "json" (single
                                        result), or "stream-json" (realtime
                                        streaming) (choices: "text", "json",
                                        "stream-json")
  --permission-mode <mode>              Permission mode to use for the session
                                        (choices: "acceptEdits", "auto",
                                        "bypassPermissions", "manual",
                                        "dontAsk", "plan")
  --permission-prompts <target>         Who answers permission prompts with
                                        --print: "host" (the SDK host or
                                        --permission-prompt-tool) or "none"
                                        (nobody: anything that would prompt is
                                        denied automatically; the permission
                                        mode still decides everything else)
                                        (choices: "host", "none", default:
                                        "host")
  -p, --print                           Print response and exit (useful for
                                        pipes).
  -r, --resume [value]                  Resume a conversation by session ID, or
                                        open interactive picker with optional
                                        search term
  --session-id <uuid>                   Use a specific session ID for the
                                        conversation (must be a valid UUID)
  -v, --version                         Output the version number
  --verbose                             Override verbose mode setting from
                                        config

Commands:
  auth <subcommand>                     Manage authentication
  mcp                                   Configure and manage MCP servers
`;
