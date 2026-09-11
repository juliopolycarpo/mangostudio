/**
 * What a settings or hook source looks like once the machine that holds it has
 * opened it, before anybody parses it.
 *
 * Shared because the reading and the parsing live on opposite sides: the
 * runtime opens the files, and the hub parses, redacts and compares the bytes.
 * The runtime contract declares them as the result of `library.settings-sources`,
 * so declaring them once keeps the reader and the parsers from drifting.
 *
 * Types only — nothing here opens a file.
 */

import type { LibraryLocationId } from './schemas';

/** Why a source that exists could not be turned into settings text. */
export type RuntimeSettingsReadFailure = 'unreadable' | 'not-regular-file' | 'too-large';

/** One `.rules` file of a `rules-dsl` location. */
export interface RuntimeSettingsRuleFile {
  readonly name: string;
  readonly content: string;
}

export interface RuntimeSettingsSource {
  readonly locationId: LibraryLocationId;
  /**
   * False when the location does not resolve on this machine or nothing is
   * there. A missing settings file is an ordinary state, not a failure.
   */
  readonly present: boolean;
  readonly sizeBytes?: number;
  readonly failureReason?: RuntimeSettingsReadFailure;
  /** Raw text, for every format except `rules-dsl`. */
  readonly content?: string;
  /** One entry per `.rules` file, name-sorted, for `rules-dsl` locations. */
  readonly rules?: readonly RuntimeSettingsRuleFile[];
}

export interface RuntimeSettingsSourcesResult {
  /**
   * This machine's home directory. The hub's parsers abbreviate paths against
   * it, and abbreviating a remote path against the hub's home would be wrong.
   */
  readonly homeDir: string;
  readonly sources: readonly RuntimeSettingsSource[];
}
