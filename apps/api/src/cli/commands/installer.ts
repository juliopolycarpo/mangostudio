/**
 * Hidden `__installer <sh|ps1>` command: prints the install script this build
 * was compiled with, verbatim, to stdout.
 *
 * `mangostudio upgrade` never downloads executable code — it runs this
 * against an archive it has already verified, and the release dry-run pipes
 * this same output through `diff` against `scripts/install/install.sh` as a
 * drift guard, so nothing here may add a byte the script itself does not
 * have: no trailing newline, no log prefix.
 */

import {
  embeddedInstaller,
  type InstallerKind,
} from '../../modules/updates/infrastructure/embedded-installers';
import { CliError } from '../errors';

const ACCEPTED_KINDS = 'sh, ps1';

function parseInstallerKind(value: string | undefined): InstallerKind {
  if (value === 'sh' || value === 'ps1') return value;
  const named = value ? `Unknown installer kind: ${value}` : 'Missing installer kind';
  throw new CliError(`${named}. Expected one of: ${ACCEPTED_KINDS}`);
}

/** Writes the embedded install script verbatim to stdout. // Usage: runInstaller(['sh']) */
export function runInstaller(args: string[]): void {
  const kind = parseInstallerKind(args[0]);
  process.stdout.write(embeddedInstaller(kind));
}
