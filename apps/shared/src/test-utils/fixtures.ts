/**
 * Small browser-safe fixture sequence shared by one module graph. The default
 * sequence starts from a random seed. Explicit seeding repeats identifiers as
 * well as text, so use explicit ids or makeTestIdentity for persisted rows
 * across resets. Processes have independent sequences; this is not a security
 * primitive or a cross-process uniqueness service.
 */
let state = Math.floor(Math.random() * 0x1_0000_0000) >>> 0;

function word(): number {
  state = (state + 0x6d2b79f5) >>> 0;
  let value = state;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return (value ^ (value >>> 14)) >>> 0;
}

function token(length: number): string {
  return Array.from({ length }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[word() % 36]).join('');
}

/** Project-owned fixture values. Example: fixtures.seed(42); fixtures.uuid(). */
export const fixtures = {
  /** Restarts the module-local sequence from a uint32 seed. Example: fixtures.seed(42). */
  seed(seed: number): void {
    state = seed >>> 0;
  },

  /** Creates a v4-shaped test id. Example: fixtures.uuid(). */
  uuid(): string {
    const bytes = new Uint8Array(16);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = word() & 255;
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  },

  /** Creates a short test name. Example: fixtures.name(). */
  name(): string {
    return `Test ${token(8)}`;
  },

  /** Creates a test-domain email. Example: fixtures.email(). */
  email(): string {
    return `${token(16)}@mangostudio.test`;
  },

  /** Creates a four-character masked suffix. Example: fixtures.suffix(). */
  suffix(): string {
    return token(4);
  },

  /** Creates space-separated fixture words. Example: fixtures.words(3). */
  words(count: number): string {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`fixtures.words: expected a nonnegative safe integer | received: ${count}`);
    }
    return Array.from({ length: count }, () => token(6)).join(' ');
  },

  /** Creates a short sentence. Example: fixtures.sentence(). */
  sentence(): string {
    return `${fixtures.words(5)}.`;
  },

  /** Creates an extension-free safe basename. Example: `${fixtures.fileName()}.png`. */
  fileName(): string {
    return `fixture-${token(8)}`;
  },

  /** Creates a connector/company label. Example: fixtures.companyName(). */
  companyName(): string {
    return `Fixture ${token(8)} Ltd`;
  },
};
