/**
 * Every shape the runtime contract's methods move, one module per family.
 *
 * Schema-first throughout: the TypeBox schema is the declaration and the public
 * type is `Static<>` of it. That is not a style preference here — the schema is
 * what `serve` validates an inbound payload against, what the catalog carries
 * to a peer written in another language, and what that peer generates its own
 * types from. A hand-written interface beside a schema is a second declaration
 * of the same thing that only one of the two ends can see.
 *
 * Split by family rather than kept as one file because the families have
 * nothing to say to each other: `fs` and `mcp` share the wire and nothing else,
 * and a reviewer looking at a filesystem method should not be reading past a
 * thousand lines of library propagation to find it.
 *
 * @example
 * import { RuntimeReadFileParamsSchema } from '@mangostudio/shared/runtime-contract';
 */

export * from './common';
export * from './fs';
export * from './install';
export * from './library';
export * from './mcp';
export * from './probing';
export * from './shell';
export * from './snapshot';
export * from './terminal';
export * from './update';
export * from './workspace';
