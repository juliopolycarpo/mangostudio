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

/**
 * Thrown by a set that could run its tool but could not produce a faithful
 * capture.
 *
 * Sign-in is the case this exists for, and it is not hypothetical: a signed-out
 * `claude auth status` answers with three fields instead of seven, and a
 * signed-out `cursor-agent acp` cannot open a session at all. Capturing either
 * would record a *smaller* contract than the real one, which the diff would
 * then read as the vendor having removed four fields — a fabricated breakage
 * that would fire on every CI runner, which is where credentials never are.
 *
 * Distinct from a thrown `Error` because the two deserve opposite handling: an
 * error means the capture is broken and the run should stop, a skip means this
 * machine cannot answer and should say so.
 */
export class ContractCaptureSkipped extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ContractCaptureSkipped';
  }
}

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
  resolveVersion(options: CaptureOptions): Promise<string | undefined>;
  /** Writes the artifacts into `destination`, which already exists and is empty. */
  capture(destination: string, options: CaptureOptions): Promise<CaptureReport>;
}

export interface CaptureOptions {
  /**
   * Capture against the newest published tool rather than the pinned one.
   *
   * Only Codex can honour this, because only Codex's capture names its own
   * input: `bunx @openai/codex@latest` is a different tarball, while Cursor and
   * Claude capture whatever binary is on `PATH` and it is the workflow's job to
   * put a current one there. The two runs answer different questions — pinned
   * asks "does the pin still reproduce", latest asks "did the vendor move" —
   * and only the first is a MangoStudio defect.
   */
  readonly latest: boolean;
}

/** What a capture managed to produce, when that is less than all of it. */
export interface CaptureReport {
  /**
   * Artifact names this machine could not capture faithfully.
   *
   * They are excluded from the comparison and carried forward untouched by a
   * regeneration, rather than being written short. The case this exists for is
   * a CI runner with no vendor credentials: `claude --help` answers there and
   * `claude auth status` does not, and losing the flag surface — by far the
   * more useful of the two — because the other half needs a login would give
   * up the drift signal exactly where the drift job runs.
   */
  readonly skipped?: readonly string[];
  /** Why, in one sentence, for the log and the step summary. */
  readonly reason?: string;
}
