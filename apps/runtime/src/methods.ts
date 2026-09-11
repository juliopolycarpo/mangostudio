/**
 * The runtime method shapes, now owned by `@mangostudio/shared/runtime-contract`.
 *
 * Kept as a re-export so the hub's imports from `@mangostudio/runtime` and the
 * runtime's own services keep their module path while the contract moves. New
 * code imports from the shared contract directly.
 */

export * from '@mangostudio/shared/runtime-contract';
