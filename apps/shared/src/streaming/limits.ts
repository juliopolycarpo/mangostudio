/**
 * The longest SSE frame (the text between two blank lines, in UTF-16 code
 * units) a reader of the generation stream holds. The largest payloads the hub
 * puts in one event are a few MiB (external turn payloads are capped at 2 MiB),
 * so 32 MiB is far above any frame the hub writes and still bounds a reader
 * whose peer never sends the terminator. A reader that meets a longer frame
 * treats the stream as failed.
 */
export const SSE_FRAME_MAX_CHARS = 32 * 1024 * 1024;
