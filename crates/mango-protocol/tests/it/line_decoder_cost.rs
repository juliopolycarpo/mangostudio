//! A standalone benchmark of `LineDecoder::push`: ns per input byte as a record grows, at a fixed
//! read size. It asserts nothing about time and is `#[ignore]`d, so the suite never runs it; the
//! guard that keeps `push` linear is `scan_work_stays_linear_in_the_record_size` in
//! `src/codec/ndjson.rs`.
//!
//! It uses only the public API, so the same file measures any checkout. To compare against a
//! base, copy it into a base checkout's `crates/mango-protocol/tests/it/`, add `mod
//! line_decoder_cost;` to that `main.rs`, and run the same command in both trees:
//!
//! ```sh
//! cargo test -p mango-protocol --all-features --release --test it \
//!     report_line_decoder_cost -- --ignored --nocapture
//! ```
//!
//! Each scenario prints the median over 9 passes (after a warm-up), the min-max, and the host load
//! average, which on a shared host is part of the result.

use std::time::{Duration, Instant};

use mango_protocol::codec::ndjson::{DEFAULT_MAX_FRAME_BYTES, LineDecoder, encode_line};
use mango_protocol::frame::{Frame, Request};
use serde_json::Value;

/// One `req` record whose line (without its `\n`) is `line_bytes` long, plus its terminator.
fn record_of(line_bytes: usize) -> Vec<u8> {
    const ENVELOPE: &str = r#"{"type":"req","id":"r","method":"a.b","params":""}"#;
    let padding = line_bytes.checked_sub(ENVELOPE.len()).unwrap_or_else(|| {
        panic!(
            "expected a line of at least {} bytes | received: {line_bytes}",
            ENVELOPE.len()
        )
    });
    let frame = Frame::Req(Request {
        id: "r".into(),
        method: "a.b".into(),
        params: Value::String("x".repeat(padding)),
    });
    let line = encode_line(&frame, DEFAULT_MAX_FRAME_BYTES).expect("the record encodes");
    assert_eq!(
        line.len(),
        line_bytes + 1,
        "expected a record of {line_bytes} bytes plus a terminator | received: {} bytes",
        line.len()
    );
    line
}

/// Feeds `stream` through a fresh decoder `read_bytes` at a time and returns how many frames
/// came out. A refusal or a short count is a harness bug, so it panics.
fn feed(stream: &[u8], read_bytes: usize, expected_frames: usize) -> Duration {
    let mut decoder = LineDecoder::new(DEFAULT_MAX_FRAME_BYTES);
    let mut frames = 0;
    let started = Instant::now();
    for piece in stream.chunks(read_bytes) {
        let outcome = decoder.push(piece);
        assert!(
            outcome.error.is_none(),
            "expected no refusal | received: {:?}",
            outcome.error
        );
        frames += outcome.frames.len();
    }
    let elapsed = started.elapsed();
    assert_eq!(
        frames, expected_frames,
        "expected {expected_frames} decoded frames | received: {frames}"
    );
    elapsed
}

/// `lines` copies of the same small frame, to show the per-record path did not regress.
fn short_lines(lines: usize) -> Vec<u8> {
    let one = encode_line(&Frame::Ping, DEFAULT_MAX_FRAME_BYTES).expect("ping encodes");
    one.repeat(lines)
}

fn median(sorted: &[f64]) -> f64 {
    sorted[sorted.len() / 2]
}

fn load_average() -> String {
    std::fs::read_to_string("/proc/loadavg")
        .map(|text| {
            text.split_whitespace()
                .take(3)
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_else(|_| "unavailable".to_owned())
}

#[test]
#[ignore = "prints a timing table; run with --release --ignored --nocapture"]
fn report_line_decoder_cost() {
    const PASSES: usize = 9;
    const KIB: usize = 1024;
    const MIB: usize = 1024 * KIB;

    // (label, stream, frames, read size). The first block holds the read size fixed while the
    // record doubles: ns per byte is flat for a linear decoder and doubles with it for a
    // quadratic one. The last record sits just under the 16 MiB default frame limit.
    let mut scenarios: Vec<(String, Vec<u8>, usize, usize)> = Vec::new();
    for line_bytes in [
        256 * KIB,
        512 * KIB,
        MIB,
        2 * MIB,
        4 * MIB,
        8 * MIB,
        16 * MIB - 64,
    ] {
        scenarios.push((
            format!("one {} KiB line / 64 KiB reads", line_bytes / KIB),
            record_of(line_bytes),
            1,
            64 * KIB,
        ));
    }
    scenarios.push((
        "one 1024 KiB line / 4 KiB reads".to_owned(),
        record_of(MIB),
        1,
        4 * KIB,
    ));
    scenarios.push((
        "one 256 KiB line / 16 B reads".to_owned(),
        record_of(256 * KIB),
        1,
        16,
    ));
    for read_bytes in [64 * KIB, 4 * KIB, 1] {
        scenarios.push((
            format!("20k short lines / {read_bytes} B reads"),
            short_lines(20_000),
            20_000,
            read_bytes,
        ));
    }

    println!("load average before: {}", load_average());
    println!("passes per scenario: {PASSES} (after one warm-up)");
    println!(
        "{:<36} {:>12} {:>20} {:>12}",
        "scenario", "ns/byte", "min-max", "ms/pass"
    );
    for (label, stream, frames, read_bytes) in &scenarios {
        feed(stream, *read_bytes, *frames);
        let mut ns_per_byte: Vec<f64> = (0..PASSES)
            .map(|_| feed(stream, *read_bytes, *frames).as_nanos() as f64 / stream.len() as f64)
            .collect();
        ns_per_byte.sort_by(f64::total_cmp);
        let middle = median(&ns_per_byte);
        println!(
            "{label:<36} {middle:>12.2} {:>20} {:>12.3}",
            format!("{:.2}-{:.2}", ns_per_byte[0], ns_per_byte[PASSES - 1]),
            middle * stream.len() as f64 / 1e6
        );
    }
    println!("load average after: {}", load_average());
}
