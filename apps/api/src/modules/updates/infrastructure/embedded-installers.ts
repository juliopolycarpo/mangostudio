/**
 * The install scripts, embedded at build time.
 *
 * `mangostudio upgrade` never downloads executable code: it writes one of these
 * to a temp file and runs it against an archive it has already verified. Because
 * the bytes are the ones this build was compiled with, an upgrade and a fresh
 * install from the same release cannot disagree about the install layout.
 *
 * `scripts/` is not a workspace, so there is no package name to import it by;
 * this is the one file allowed to reach outside `apps/api` for it.
 *
 * The `.sh`/`.ps1` module declarations live in `../../../types/text-imports.d.ts`.
 * `apps/api`'s own `tsconfig.json` picks that file up via its `include`, but any
 * consumer of `@mangostudio/api`'s `App` type (e.g. `apps/frontend`) type-checks
 * this file too, without that `include`. The reference directive below makes the
 * declaration travel with the file that needs it, instead of every downstream
 * tsconfig having to know about it.
 */

/// <reference path="../../../types/text-imports.d.ts" />

import installPs1 from '../../../../../../scripts/install/install.ps1' with { type: 'text' };
import installSh from '../../../../../../scripts/install/install.sh' with { type: 'text' };

export type InstallerKind = 'sh' | 'ps1';

/** The embedded installer text for one shell. // Usage: embeddedInstaller('sh') */
export function embeddedInstaller(kind: InstallerKind): string {
  return kind === 'sh' ? installSh : installPs1;
}

/** File name the script should be written under so `bash`/`powershell` accept it. */
export function embeddedInstallerFileName(kind: InstallerKind): string {
  return kind === 'sh' ? 'install.sh' : 'install.ps1';
}
