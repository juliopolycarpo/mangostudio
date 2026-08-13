/**
 * Hands Elysia its TypeBox namespaces instead of letting it find them itself.
 *
 * Elysia loads TypeBox lazily, on the first `t.*` call, through a `createRequire`
 * built from its own module path. That works whenever a `node_modules` tree is
 * on disk, and cannot work inside a compiled standalone binary: there is nothing
 * to resolve `typebox/type` against, so the server dies at startup with
 * `Cannot find module 'typebox/type'` — after the database connects and before
 * anything answers, which reads as a server that simply never becomes ready.
 *
 * Nothing catches this earlier: the bundler is happy (the require is a runtime
 * string, not an import), every test runs against a real `node_modules`, and
 * `bun build` only compiles the binary rather than starting it.
 *
 * Importing the namespaces statically here puts them in the bundle and registers
 * them up front, which is what Elysia's own error message asks for. It must run
 * before the first schema is built, so it is a call rather than an import side
 * effect — see `registerFileTypeDetector` for the same reasoning.
 */

import { setupTypebox } from 'elysia';
import * as compile from 'typebox/compile';
import * as schema from 'typebox/schema';
import * as system from 'typebox/system';
import * as type from 'typebox/type';
import * as value from 'typebox/value';

let wired = false;

/** Register TypeBox with Elysia once per process. // Usage: wireTypeboxNamespaces() */
export function wireTypeboxNamespaces(): void {
  if (wired) return;
  wired = true;
  setupTypebox({ typebox: { type, system, value, schema, compile } });
}
