/**
 * Toolchain detection domain.
 *
 * Kept out of the `environments` barrel on purpose: these modules reach for
 * `node:path`, and the browser bundle imports that barrel for its schemas. A
 * host that can answer these questions has a filesystem; one that cannot must
 * not be made to load them.
 */

export * from './agent-cli-definitions';
export * from './auth-signal';
export * from './binary-scan';
export * from './duplicate-analysis';
export * from './fnm';
export * from './lts-policy';
export * from './node-release-schedule';
export * from './nvm';
export * from './runtime-definitions';
export * from './version-manager-support';
export * from './winget-ownership';
