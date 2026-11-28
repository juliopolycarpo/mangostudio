//! Reads the release version stamped into the linked `mangostudio-runtime` binary.
//!
//! The release version is not a compile input. `src/main.rs` carries a fixed-size slot in the
//! binary, and `scripts/lib/runtime-stamp.ts` writes the version into it after the link, so two
//! commits with equal Rust inputs compile to the same bytes and differ only in that slot.
//!
//! The slot is a 16-byte magic the patcher searches for, one length byte, and a zero-padded
//! value field:
//!
//! ```text
//! | magic: 16 bytes | length: 1 byte (0 = unstamped) | value: 64 bytes, UTF-8, zero-padded |
//! ```
//!
//! This module knows the layout but never the magic. The patcher must find exactly one copy of
//! the magic in the binary, and a comparison here would leave a second one in the machine code.

use std::fmt;

/// Bytes of the marker the patcher searches for; owned by `src/main.rs`, never compared here.
pub const MAGIC_LEN: usize = 16;

/// Longest release version the slot holds, in bytes.
///
/// `scripts/lib/runtime-stamp.ts` mirrors this and refuses a longer version at build time.
pub const VALUE_CAPACITY: usize = 64;

/// Size of the whole slot: magic, length byte and value field.
pub const SLOT_LEN: usize = MAGIC_LEN + 1 + VALUE_CAPACITY;

/// Why a slot cannot be read as a release version. Every variant means the binary was damaged or
/// stamped by something other than the build scripts, so the process refuses to run under a
/// version it cannot trust.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StampError {
    /// The length byte exceeds [`VALUE_CAPACITY`].
    LengthOutOfRange {
        /// The length byte the slot holds.
        length: usize,
    },
    /// The value field is not UTF-8 within its declared length.
    NotUtf8,
    /// The value holds a control character, such as NUL or a newline.
    ControlCharacter {
        /// Byte offset inside the value field.
        index: usize,
    },
    /// A byte after the declared length is not zero.
    DirtyPadding {
        /// Byte offset inside the value field.
        index: usize,
    },
}

impl fmt::Display for StampError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::LengthOutOfRange { length } => write!(
                formatter,
                "release stamp length: expected 0..={VALUE_CAPACITY} | received: {length}"
            ),
            Self::NotUtf8 => write!(
                formatter,
                "release stamp value: expected UTF-8 | received: invalid bytes"
            ),
            Self::ControlCharacter { index } => write!(
                formatter,
                "release stamp value: expected printable text | received: control byte at index {index}"
            ),
            Self::DirtyPadding { index } => write!(
                formatter,
                "release stamp padding: expected zero bytes after the value | received: non-zero byte at index {index}"
            ),
        }
    }
}

impl std::error::Error for StampError {}

/// The version stamped into `slot`, or `None` when the slot is unstamped (length byte 0).
///
/// # Errors
///
/// Returns a [`StampError`] when the length byte, the value or its zero padding is malformed.
///
/// # Example
///
/// ```
/// use mangostudio_runtime::release_stamp::{stamped_release, SLOT_LEN};
///
/// let mut slot = [0u8; SLOT_LEN];
/// assert_eq!(stamped_release(&slot), Ok(None));
///
/// slot[16] = 5;
/// slot[17..22].copy_from_slice(b"1.2.3");
/// assert_eq!(stamped_release(&slot), Ok(Some("1.2.3")));
/// ```
pub fn stamped_release(slot: &[u8; SLOT_LEN]) -> Result<Option<&str>, StampError> {
    let length = usize::from(slot[MAGIC_LEN]);
    if length > VALUE_CAPACITY {
        return Err(StampError::LengthOutOfRange { length });
    }
    let value_field = &slot[MAGIC_LEN + 1..];
    let (value, padding) = value_field.split_at(length);
    if let Some(index) = padding.iter().position(|byte| *byte != 0) {
        return Err(StampError::DirtyPadding {
            index: length + index,
        });
    }
    if length == 0 {
        return Ok(None);
    }
    let text = std::str::from_utf8(value).map_err(|_| StampError::NotUtf8)?;
    if let Some(index) = text.bytes().position(|byte| byte.is_ascii_control()) {
        return Err(StampError::ControlCharacter { index });
    }
    Ok(Some(text))
}

/// The release this binary reports: the stamped version, or `manifest_version` for a binary
/// nobody stamped (`cargo build`, `cargo run`, `cargo test`).
///
/// # Errors
///
/// Returns a [`StampError`] when the slot is stamped but malformed. A damaged stamp must not
/// quietly fall back to the manifest version: the hub refuses a runtime whose release differs
/// from its own, and the failure should name the damaged slot rather than a version mismatch.
///
/// # Example
///
/// ```
/// use mangostudio_runtime::release_stamp::{release_version, SLOT_LEN};
///
/// assert_eq!(release_version(&[0u8; SLOT_LEN], "0.1.1"), Ok("0.1.1"));
/// ```
pub fn release_version<'a>(
    slot: &'a [u8; SLOT_LEN],
    manifest_version: &'a str,
) -> Result<&'a str, StampError> {
    Ok(stamped_release(slot)?.unwrap_or(manifest_version))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A slot holding `value`, laid out the way the patcher writes it.
    fn stamped_slot(value: &[u8]) -> [u8; SLOT_LEN] {
        let mut slot = [0u8; SLOT_LEN];
        slot[MAGIC_LEN] = u8::try_from(value.len()).expect("test values fit one length byte");
        slot[MAGIC_LEN + 1..MAGIC_LEN + 1 + value.len()].copy_from_slice(value);
        slot
    }

    #[test]
    fn an_unstamped_slot_reports_no_stamp_and_falls_back_to_the_manifest() {
        let slot = [0u8; SLOT_LEN];

        assert_eq!(stamped_release(&slot), Ok(None));
        assert_eq!(release_version(&slot, "0.1.1"), Ok("0.1.1"));
    }

    #[test]
    fn a_stamped_slot_wins_over_the_manifest_version() {
        let slot = stamped_slot(b"0.1.1-canary.1234abc");

        assert_eq!(stamped_release(&slot), Ok(Some("0.1.1-canary.1234abc")));
        assert_eq!(release_version(&slot, "0.1.1"), Ok("0.1.1-canary.1234abc"));
    }

    #[test]
    fn a_value_filling_the_whole_field_is_read() {
        let value = [b'9'; VALUE_CAPACITY];
        let slot = stamped_slot(&value);

        assert_eq!(
            stamped_release(&slot).map(|found| found.map(str::len)),
            Ok(Some(VALUE_CAPACITY))
        );
    }

    #[test]
    fn a_length_above_the_capacity_is_refused_with_the_length() {
        let mut slot = [0u8; SLOT_LEN];
        slot[MAGIC_LEN] = 65;

        let error = release_version(&slot, "0.1.1").expect_err("65 exceeds the 64-byte field");

        assert_eq!(error, StampError::LengthOutOfRange { length: 65 });
        assert_eq!(
            error.to_string(),
            "release stamp length: expected 0..=64 | received: 65"
        );
    }

    #[test]
    fn a_non_zero_byte_after_the_value_is_refused_at_its_index() {
        let mut slot = stamped_slot(b"1.2.3");
        slot[MAGIC_LEN + 1 + 7] = b'x';

        assert_eq!(
            stamped_release(&slot),
            Err(StampError::DirtyPadding { index: 7 })
        );
    }

    #[test]
    fn a_value_written_while_the_length_is_zero_is_refused_not_ignored() {
        let mut slot = [0u8; SLOT_LEN];
        slot[MAGIC_LEN + 1] = b'1';

        assert_eq!(
            release_version(&slot, "0.1.1"),
            Err(StampError::DirtyPadding { index: 0 })
        );
    }

    #[test]
    fn invalid_utf8_is_refused() {
        let slot = stamped_slot(&[0xff, 0xfe]);

        assert_eq!(stamped_release(&slot), Err(StampError::NotUtf8));
    }

    #[test]
    fn a_control_character_in_the_value_is_refused_at_its_index() {
        let slot = stamped_slot(b"1.2\n3");

        assert_eq!(
            stamped_release(&slot),
            Err(StampError::ControlCharacter { index: 3 })
        );
    }
}
