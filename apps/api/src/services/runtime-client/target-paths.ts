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
  /** Home directory of the target, used to expand `~`. May be empty. */
  readonly homeDir: string;
  isAbsolute(path: string): boolean;
  /** Canonical form of an already-absolute path: `.`, `..`, and trailing separators removed. */
  canonical(path: string): string;
  /** Joins a relative path onto an absolute base, canonicalizing the result. */
  join(base: string, path: string): string;
  /** True when `candidate` is `root` or a path below it. Both must be canonical. */
  contains(root: string, candidate: string): boolean;
}

export function createTargetPaths(manifest: RuntimeCapabilityManifest): TargetPaths {
  const impl = manifest.pathStyle === 'win32' ? win32 : posix;
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
    homeDir: manifest.homeDir,
    isAbsolute: (path) => impl.isAbsolute(path),
    canonical,
    // `base` is absolute at every call site, so `resolve` cannot reach for the
    // hub's cwd; it is used here only for its segment folding.
    join: (base, path) => canonical(impl.resolve(base, path)),
    contains: (root, candidate) =>
      candidate === root || candidate.startsWith(root.endsWith(impl.sep) ? root : root + impl.sep),
  };
}
