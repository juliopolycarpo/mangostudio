/**
 * Path semantics of the environment a call is bound for.
 *
 * The hub resolves a tool's path arguments before it sends them, and a Windows
 * hub driving a WSL distro has to do that the way the distro would: `~` is the
 * runtime's home directory rather than the hub's, and a relative path joins
 * with the runtime's separator. The capability manifest already reports both
 * facts, so nothing here needs the target to answer a question first.
 *
 * Everything below is lexical and never consults the hub's own cwd — that is
 * the directory `node:path`'s own `resolve` falls back to, and it is a
 * directory the target need not have at all.
 */

import { posix, win32 } from 'node:path';
import type { RuntimeCapabilityManifest } from '@mangostudio/shared/runtime-protocol';

type PathStyle = RuntimeCapabilityManifest['pathStyle'];

export interface TargetPaths {
  readonly style: PathStyle;
  readonly sep: string;
  /** Home directory of the target, used to expand `~`. Empty when unusable. */
  readonly homeDir: string;
  isAbsolute(path: string): boolean;
  /** Canonical form of an already-absolute path: `.`, `..`, and trailing separators removed. */
  canonical(path: string): string;
  /**
   * Joins a relative path onto an absolute base, canonicalizing the result.
   * A relative `base` would send the result to the hub's own working directory,
   * so callers check it first — see `resolveWorkdirRelativePath`.
   */
  join(base: string, path: string): string;
  /** True when `candidate` is `root` or a path below it. Both must be canonical. */
  contains(root: string, candidate: string): boolean;
}

export function createTargetPaths(manifest: RuntimeCapabilityManifest): TargetPaths {
  const impl = manifest.pathStyle === 'win32' ? win32 : posix;
  // Windows reaches the same file under any casing, so a root and a path below
  // it can be written differently and still name one location: `C:\Secrets`
  // has to contain `c:\secrets\notes.md`. Only the comparison folds — every
  // path handed back keeps the case it arrived in.
  const fold =
    manifest.pathStyle === 'win32' ? (path: string) => path.toLowerCase() : (path: string) => path;
  const canonical = (path: string): string => {
    const normalized = impl.normalize(path);
    const root = impl.parse(normalized).root;
    // `normalize` keeps a trailing separator, and a root stored as `/project/`
    // prefixes none of its own contents once the separator is appended again.
    const trimmed = normalized.replace(/[\\/]+$/, '');
    return trimmed.length > root.length ? trimmed : root || normalized;
  };

  return {
    style: manifest.pathStyle,
    sep: impl.sep,
    // The manifest is a claim by the other end, and a relative home directory
    // would send every `~` expansion to the hub's own working directory.
    // Dropping it leaves the tilde literal, which fails as a name the target
    // does not have rather than as a real path on the wrong host.
    homeDir: impl.isAbsolute(manifest.homeDir) ? manifest.homeDir : '',
    isAbsolute: (path) => impl.isAbsolute(path),
    canonical,
    // `base` is absolute at every call site, so `resolve` cannot reach for the
    // hub's cwd; it is used here only for its segment folding.
    join: (base, path) => canonical(impl.resolve(base, path)),
    contains: (root, candidate) => {
      const foldedRoot = fold(root);
      const foldedCandidate = fold(candidate);
      return (
        foldedCandidate === foldedRoot ||
        foldedCandidate.startsWith(
          foldedRoot.endsWith(impl.sep) ? foldedRoot : foldedRoot + impl.sep
        )
      );
    },
  };
}
