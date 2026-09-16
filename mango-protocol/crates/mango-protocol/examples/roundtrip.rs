//! Decodes every line on stdin independently and answers one line per input,
//! for the repository's cross-language round-trip check.
//!
//! Each answer is `OK<TAB><frame re-encoded by this crate>` or
//! `ERR<TAB><refusal reason>` where the reason is the corpus vocabulary
//! (`invalid-json`, `schema`, `too-large`). Blank input lines are skipped.
//!
//! ```text
//! printf '{"type":"ping"}\n{"type":"nope"}\n' | cargo run --example roundtrip
//! ```

use std::io::{self, BufRead, Write};

use mango_protocol::codec::ndjson::{DEFAULT_MAX_FRAME_BYTES, decode_line, encode_frame_bytes};

fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = stdout.lock();
    for line in stdin.lock().split(b'\n') {
        let line = line?;
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        match decode_line(&line, DEFAULT_MAX_FRAME_BYTES) {
            Ok(frame) => {
                let bytes = encode_frame_bytes(&frame, DEFAULT_MAX_FRAME_BYTES)
                    .map_err(|error| io::Error::other(error.to_string()))?;
                out.write_all(b"OK\t")?;
                out.write_all(&bytes)?;
                out.write_all(b"\n")?;
            }
            Err(error) => {
                writeln!(out, "ERR\t{}", error.kind.reason())?;
            }
        }
    }
    out.flush()
}
