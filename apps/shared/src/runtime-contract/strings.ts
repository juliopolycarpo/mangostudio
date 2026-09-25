/**
 * The contracts between a hub and a runtime that are not schemas: a string one
 * process greps for in another's stderr, an exit code a supervisor reads, and
 * the prefix that identifies a credential on sight.
 *
 * They are as much a part of the boundary as the method table, and they are
 * the part a peer written in another language is most likely to get wrong,
 * because nothing about them is derivable — a value spelled slightly
 * differently compiles on both sides and fails only in production. Declared
 * here, emitted into `strings.json`, and read from there by anything that is
 * not TypeScript.
 *
 * A leaf, like {@link ../runtime-contract/errors}: it imports nothing, so no
 * module can be pulled into a cycle by needing one constant.
 */

/**
 * What a runtime prints to stderr when nobody on its machine has answered the
 * consent question yet, and the sentence built around it.
 *
 * It is a constant because a second party reads it. A hub launching a runtime
 * over SSH sees only the remote side's exit code and stderr — ssh reports its
 * own failures as 255 and passes everything else through — so "not set up yet"
 * and "no binary there" are told apart by signature. Two spellings of the same
 * refusal would make the hub classify a consent gate as a missing install and
 * send the user to reinstall something that is already present.
 */
export const RUNTIME_SETUP_PENDING_SIGNATURE = 'runtime setup is pending on this machine';

/** Distinct from ordinary failure so a supervisor can identify an intentional restart. */
export const RUNTIME_UPDATE_EXIT_CODE = 75;

/**
 * Marks a runtime pairing token in a paste or a bug report for what it is.
 *
 * The hub mints it and the runtime stores it, so the prefix is a shared fact
 * rather than a hub detail: a credential file written by one process is read
 * by the other, and a secret scanner keyed on the wrong prefix protects
 * nothing.
 */
export const RUNTIME_PAIRING_TOKEN_PREFIX = 'mrt_';

/**
 * The `hello.capabilities` member a hub announces its binding key under.
 *
 * A binding key names the environment record a connection speaks for, opaque
 * to the runtime. A `serve` runtime holds one hub connection at a time; the
 * key is what lets it tell the same record reconnecting (which supersedes the
 * old socket) from a second record pointing at the same runtime (which is
 * refused while the first is live). Beside `hub` rather than inside it, for
 * the reason `HubExternalAgentIsolationSchema` gives.
 */
export const HUB_BINDING_KEY_CAPABILITY = 'bindingKey';

/** Longest binding key a runtime compares; a longer one is treated as absent. */
export const HUB_BINDING_KEY_MAX_LENGTH = 128;

/**
 * The close code a runtime refuses a hub connection with when a live
 * connection for a different binding key already holds it.
 *
 * Application-owned, in the protocol's unnamed `4000–4999` range: 423 is
 * HTTP's "Locked". Not in the protocol's fatal set — the hub retries it, only
 * slowly, because the incumbent may go away.
 */
export const RUNTIME_ALREADY_BOUND_CLOSE_CODE = 4423;

/** The close reason sent with {@link RUNTIME_ALREADY_BOUND_CLOSE_CODE}. */
export const RUNTIME_ALREADY_BOUND_REASON = 'runtime already bound to another environment';
