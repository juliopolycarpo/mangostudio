/**
 * The greeting a runtime built on `runtime-protocol` 1.0.1 sends to a hub.
 *
 * Captured from that codec before it was deleted, and frozen here on purpose:
 * these bytes are what an old binary still on somebody's machine puts on the
 * wire, and the test that proves this hub closes such a peer with 4426 is only
 * worth anything if the input is the real thing. **Never regenerate them** —
 * there is nothing left to regenerate them from, and rewriting them by hand
 * would turn the assertion into a tautology about this build.
 *
 * The frame arrives as WebSocket messages: a nine-byte header — format version
 * 1, then the big-endian chunk index and count — followed by the JSON. This
 * frame fits in one message, so there is exactly one.
 */

const HELLO_JSON =
  '{"type":"hello","protocolVersion":"1.0.1","runtimeVersion":"runtime-legacy","manifest":{"platform":"linux","arch":"x64","pathStyle":"posix","homeDir":"/home/runner","shells":["bash"],"git":{"available":true,"version":"2.44.0"},"features":{"tools":true,"git":true,"probing":false,"mcp":false,"library":false,"checkpoints":true}}}';

/** Version 1, chunk index 0, chunk count 1. */
const CHUNK_HEADER = Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0, 1);

/** The greeting as the WebSocket messages a 1.0.1 runtime sends. */
export const LEGACY_HELLO_1_0_1_CHUNKS: readonly Uint8Array[] = [
  Uint8Array.from([...CHUNK_HEADER, ...new TextEncoder().encode(HELLO_JSON)]),
];
