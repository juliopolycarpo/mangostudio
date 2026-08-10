/**
 * What this adapter was written against, and what a live `cursor-agent` must be
 * for it to apply.
 *
 * `cursor-agent acp` is **absent from `cursor-agent --help`**. It is documented
 * at cursor.com/docs/cli/acp as the way to build custom clients, with no
 * experimental or beta label, and it answered a protocol-1 handshake on the
 * build below — but a subcommand the CLI's own help does not list is a version
 * risk of the same weight as Codex's `[experimental]` marker. The mitigation is
 * the same shape: pin a minimum version here, and probe the handshake at
 * discovery rather than assuming the subcommand exists. Plan 010 makes that
 * systematic; this is its Cursor half.
 */

/**
 * The oldest `cursor-agent` this adapter will drive.
 *
 * Cursor versions are calendar-shaped (`YYYY.MM.DD-hash`), and this is the only
 * build the ACP surface has been observed against. Newer is allowed for the
 * same reason Codex allows it: the reducer ignores update variants it does not
 * know, and refusing an upgrade the user installed themselves would turn a
 * drift warning into an outage. Older is refused, because nothing establishes
 * that `acp` existed or behaved this way before it.
 */
export const MINIMUM_CURSOR_AGENT_VERSION = '2026.08.04' as const;

/**
 * The ACP major version this client speaks.
 *
 * Exact, not a floor. ACP negotiates a single integer, and a server answering a
 * different one is describing a protocol whose frames this reducer has never
 * seen. Downgrading silently is what the handshake gate exists to prevent.
 */
export const CURSOR_ACP_PROTOCOL_VERSION = 1;

/** The command that signs a user in, shown with a copy button when signed out. */
export const CURSOR_LOGIN_COMMAND = 'cursor-agent login' as const;

/** How the shared JSON-RPC client names this peer in timeouts and teardowns. */
export const CURSOR_PEER_NAME = 'Cursor ACP server';

/**
 * Documented Cursor directories the child is allowed to inherit.
 *
 * `cursor-agent` keeps its CLI configuration under `$HOME/.cursor` and its
 * credentials under `$XDG_CONFIG_HOME/cursor` (verified on Linux: `auth.json`
 * lives there while `cli-config.json` and `acp-config.json` live under
 * `$HOME/.cursor`). `HOME` is already in the base allowlist; without the XDG
 * variables a user who relocated their config would appear signed out. These
 * are XDG path variables, not application configuration, and nothing a hub
 * request carries can add to this list.
 */
export const CURSOR_VENDOR_ENVIRONMENT_KEYS = [
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
] as const;

/**
 * How long a successful discovery answer stays good.
 *
 * Discovery is not a file read here: it starts `cursor-agent acp`, completes a
 * handshake and opens a throwaway session to read the model catalog, which is
 * the only place Cursor exposes one. The hub already caches per (user,
 * environment) for 30s, so without a second cache on this side every selector
 * render past that window pays for a process launch. Ten minutes is long enough
 * that browsing costs nothing and short enough that a `cursor-agent update`
 * shows up while the user is still looking for it — and the version, executable
 * path and account fingerprint are all part of the key, so the common reasons
 * an answer goes stale invalidate it immediately rather than waiting.
 */
export const CURSOR_DISCOVERY_CACHE_TTL_MS = 10 * 60_000;

/**
 * How long a *failed* discovery is remembered.
 *
 * Short, and deliberately not zero. A binary that cannot complete the handshake
 * fails slowly — it is a process launch plus a timeout — and retrying that on
 * every render turns one broken install into a stall on every selector open.
 * Fifteen seconds is under the hub's own cache TTL, so a user who fixes their
 * install is never more than one refresh away from seeing it.
 */
export const CURSOR_DISCOVERY_FAILURE_CACHE_TTL_MS = 15_000;

/**
 * How many times one discovery call retries the handshake.
 *
 * Two attempts, not more. The failures worth a retry are the transient ones —
 * a cold binary losing a race with its own startup, a machine under load
 * missing the handshake deadline — and those clear on the second try. A missing
 * subcommand, an unexpected protocol version or a signed-out account fail
 * identically however many times they are asked, and discovery sits on the path
 * to rendering a selector.
 */
export const CURSOR_DISCOVERY_ATTEMPTS = 2;
