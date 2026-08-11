/**
 * One vendor surface MangoStudio pins, as data.
 *
 * Three sets, three completely different production mechanisms — Codex has a
 * generator, Cursor answers a JSON-RPC handshake, Claude prints help text — and
 * one shape over all of them, so `contracts.ts` can regenerate and diff them
 * without knowing which is which.
 *
 * Artifacts live beside the adapter that reads them rather than in a shared
 * fixtures directory, because a vendor's contract is that adapter's business
 * and nobody else's. The manifest always sits in `<vendor>/contract/`; the
 * artifacts sit there too, except for Codex, whose generator owns
 * `<vendor>/protocol/` and writes the whole tree itself.
 */

type VendorId = 'codex' | 'cursor' | 'claude';

export interface VendorContractSet {
  /** Stable id, used by `--only` and recorded in the manifest. */
  readonly id: string;
  readonly vendor: VendorId;
  /** Exactly what reproduces this capture, as a maintainer would type it. */
  readonly command: string;
  /** Absolute path to the committed artifacts. */
  readonly artifactsDirectory: string;
  /** Absolute path to the directory holding `manifest.json`. */
  readonly manifestDirectory: string;
  /** False where the artifacts are a generated tree rather than a few files. */
  readonly perFileDigests: boolean;
  /**
   * The vendor build this capture would run against.
   *
   * `undefined` means the tool is not on this machine. Callers skip the set
   * loudly rather than treating an unrunnable capture as a passing one — a
   * green check that verified nothing is the worst outcome available here.
   */
  resolveVersion(): Promise<string | undefined>;
  /** Writes the artifacts into `destination`, which already exists and is empty. */
  capture(destination: string): Promise<void>;
}
