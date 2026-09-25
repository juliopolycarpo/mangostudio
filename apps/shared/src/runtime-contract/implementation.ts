/**
 * What a runtime *build* implements, independent of consent and of what the
 * machine happens to have right now.
 *
 * Three discovery questions are kept apart on purpose:
 *
 * - `rpc.discover` answers "what does the contract declare?" — the full
 *   catalog, identical for every build that speaks this contract version. It
 *   is never proof that a method is implemented.
 * - `hello.capabilities.implementation` answers "which feature groups does this
 *   build implement?" — the authoritative ceiling for the connection, sent
 *   with the handshake so the common path needs no extra round-trip.
 * - `runtime.discover` answers "exactly which methods does this build
 *   implement?" — the detailed surface, fetched on demand and cached by the
 *   hub under the fingerprint the handshake announced.
 *
 * `features` in the same manifest stays the effective answer (consent ∩
 * availability ∩ implementation). Keeping implementation separate is what lets
 * a hub apply a later consent grant without a reconnect while a build gap stays
 * closed.
 */

import Type, { type Static } from 'typebox';

/**
 * Version of the implementation descriptor itself — the `features` key set and
 * the fingerprint recipe. Bumped only when either changes meaning.
 */
export const RUNTIME_IMPLEMENTATION_SCHEMA_VERSION = 1;

/**
 * Feature groups a build implements, keyed like `features` in the manifest.
 *
 * Every key is required: an implementation descriptor that says nothing about
 * a group has not said "yes". `terminal` is the PTY family (`terminal.*`);
 * `toolchain` is omitted because it names a request shape, not a group of
 * methods.
 */
export const RuntimeImplementationFeaturesSchema = Type.Object({
  git: Type.Boolean(),
  probing: Type.Boolean(),
  mcp: Type.Boolean(),
  library: Type.Boolean(),
  checkpoints: Type.Boolean(),
  fsRead: Type.Boolean(),
  fsWrite: Type.Boolean(),
  shell: Type.Boolean(),
  update: Type.Boolean(),
  externalAgents: Type.Boolean(),
  terminal: Type.Boolean(),
});
export type RuntimeImplementationFeatures = Static<typeof RuntimeImplementationFeaturesSchema>;

/**
 * Lowercase hex SHA-256 identifying one implementation surface.
 *
 * The runtime computes it over the UTF-8 text
 * `schema=<n>\nmethods=<sorted method names joined by ",">\nfeatures=<sorted
 * implemented feature keys joined by ",">\n`. It never covers consent,
 * machine facts, or credentials, so the same build answers the same value on
 * every machine and under every consent profile. The hub treats it as opaque.
 */
export const RuntimeImplementationFingerprintSchema = Type.String({ pattern: '^[0-9a-f]{64}$' });

/**
 * The implementation ceiling a runtime announces in `hello.capabilities`.
 *
 * Absent on older peers, including the TypeScript runtime; a hub must then
 * treat the handshake `features` as the ceiling, fail-closed.
 */
export const RuntimeImplementationSchema = Type.Object({
  schema: Type.Integer({ minimum: 1 }),
  fingerprint: RuntimeImplementationFingerprintSchema,
  features: RuntimeImplementationFeaturesSchema,
});
export type RuntimeImplementation = Static<typeof RuntimeImplementationSchema>;

/**
 * `runtime.discover`'s answer: the implementation ceiling plus every method
 * this build registers, sorted and unique.
 *
 * Requires no consent capability and does not change with consent, machine
 * availability, or authentication.
 */
export const RuntimeDiscoverResultSchema = Type.Object({
  schema: Type.Integer({ minimum: 1 }),
  fingerprint: RuntimeImplementationFingerprintSchema,
  features: RuntimeImplementationFeaturesSchema,
  methods: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
});
export type RuntimeDiscoverResult = Static<typeof RuntimeDiscoverResultSchema>;
