/**
 * The library registry and the probes that read it off a real filesystem.
 *
 * Kept out of the `library` barrel on purpose: path resolution reaches for
 * `node:path`, and the browser bundle imports that barrel for its schemas.
 */

export * from './fs-probe';
export * from './location-probe';
export * from './registry';
