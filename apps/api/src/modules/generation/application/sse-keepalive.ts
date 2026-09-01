/**
 * Tight on purpose. The silent stretch of an image generation (or a vendor
 * CLI sitting on a long tool call) is where flaky intermediaries (observed:
 * the WSL2 localhost relay, issue #994) kill an idle connection — twice
 * measured dying 8-11s into the gap, before a 15s beat could fire. A comment
 * frame every 5s costs ~15 bytes and keeps the connection visibly alive
 * through the longest tool call.
 *
 * Shared by both `/respond/stream` producers (internal turns in
 * respond-stream-routes.ts, external turns in external-turn-stream.ts) so the
 * two halves of one chat streaming experience cannot drift apart.
 */
export const KEEPALIVE_INTERVAL_MS = 5_000;
