/**
 * Resolving a workspace path against a real filesystem.
 *
 * Kept out of the `workspaces` barrel for the reason `library/host` is: path
 * resolution reaches for `node:fs` and `node:path`, and the browser bundle
 * imports that barrel for its schemas.
 *
 * Both ends need these. A runtime checks a path it is about to open against
 * the containment root the call carried; the hub checks the same path before
 * it sends the call, and again for the files it reads on its own machine. Two
 * implementations of "is this inside" would disagree about a symlink, and the
 * disagreement would show up as a write landing somewhere the check approved.
 */

export * from './path';
export * from './path-containment';
