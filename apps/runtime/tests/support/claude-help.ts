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
