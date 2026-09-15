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
