//! One rule, shared by every builder and codec entry point that takes a
//! byte or count ceiling: refuse anything below the spec's floor for it.
//!
//! [`check_at_least`] is for an infallible builder — it panics, naming the
//! floor it broke, the way `SessionOptions::with_max_frame_bytes` and its
//! siblings do. [`checked_at_least`] is the same rule for a caller that
//! already returns a `Result` — [`crate::codec::ndjson::encode_frame_bytes`]
//! and its siblings use it instead of panicking, so a codec entry point
//! never aborts the process over a caller-supplied ceiling.

/// The message both [`check_at_least`] and [`checked_at_least`] use, naming
/// the received value and the floor it fell under.
fn message(name: &str, value: usize, floor: usize) -> String {
    format!("{name} is {value}; expected at least {floor}")
}

/// Returns `value` when it is at or above `floor`; panics otherwise, naming both.
///
/// # Panics
///
/// Panics when `value` is below `floor`, with the message
/// `"<name> is <value>; expected at least <floor>"`.
///
/// # Example
///
/// ```
/// use mango_protocol::codec::limits::check_at_least;
///
/// assert_eq!(check_at_least("max_frame_bytes", 8192, 4096), 8192);
/// ```
#[must_use]
pub fn check_at_least(name: &str, value: usize, floor: usize) -> usize {
    assert!(value >= floor, "{}", message(name, value, floor));
    value
}

/// [`check_at_least`] for the one ceiling nearly every builder in this crate
/// takes: the frame limit, against [`crate::codec::ndjson::MIN_MAX_FRAME_BYTES`].
/// Every transport's `with_max_frame_bytes` spells the same rule, so it is
/// spelled once here.
///
/// # Panics
///
/// Panics when `max_frame_bytes` is below
/// [`crate::codec::ndjson::MIN_MAX_FRAME_BYTES`], naming both.
///
/// # Example
///
/// ```
/// use mango_protocol::codec::limits::check_max_frame_bytes;
///
/// assert_eq!(check_max_frame_bytes(8192), 8192);
/// ```
#[must_use]
pub fn check_max_frame_bytes(max_frame_bytes: usize) -> usize {
    check_at_least(
        "max_frame_bytes",
        max_frame_bytes,
        crate::codec::ndjson::MIN_MAX_FRAME_BYTES,
    )
}

/// [`check_at_least`]'s rule for a caller that must return a `Result`
/// instead of panicking: `Ok(value)` at or above `floor`, an `Err` naming
/// both otherwise.
///
/// # Example
///
/// ```
/// use mango_protocol::codec::limits::checked_at_least;
///
/// assert_eq!(checked_at_least("max_frame_bytes", 8192, 4096), Ok(8192));
/// assert_eq!(
///     checked_at_least("max_frame_bytes", 512, 4096),
///     Err("max_frame_bytes is 512; expected at least 4096".to_string())
/// );
/// ```
pub fn checked_at_least(name: &str, value: usize, floor: usize) -> Result<usize, String> {
    if value < floor {
        return Err(message(name, value, floor));
    }
    Ok(value)
}

#[cfg(test)]
/// Runs `body`, expecting it to panic, and hands back the panic payload as a
/// string — formatted `panic!`/`assert!` payloads are always `String`, never
/// `&str`. Shared by every builder's panic table so each file states only
/// the expected message, not the `catch_unwind` boilerplate around it.
///
/// # Example
///
/// ```ignore
/// let message = panic_message(|| { check_at_least("n", 1, 2); });
/// assert_eq!(message, "n is 1; expected at least 2");
/// ```
pub(crate) fn panic_message(body: impl FnOnce()) -> String {
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(body))
        .expect_err("expected a panic, the builder returned");
    match outcome.downcast::<String>() {
        Ok(message) => *message,
        Err(payload) => match payload.downcast::<&str>() {
            Ok(message) => (*message).to_string(),
            Err(_) => panic!("panic payload was not a string"),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::{check_at_least, check_max_frame_bytes, checked_at_least, panic_message};
    use crate::codec::ndjson::MIN_MAX_FRAME_BYTES;

    #[test]
    fn the_frame_ceiling_rule_names_the_floor_of_the_wire() {
        assert_eq!(
            check_max_frame_bytes(MIN_MAX_FRAME_BYTES),
            MIN_MAX_FRAME_BYTES
        );
        let message = panic_message(|| {
            let _ = check_max_frame_bytes(MIN_MAX_FRAME_BYTES - 1);
        });
        assert_eq!(
            message,
            format!(
                "max_frame_bytes is {}; expected at least {MIN_MAX_FRAME_BYTES}",
                MIN_MAX_FRAME_BYTES - 1
            )
        );
    }

    #[test]
    fn accepts_a_value_at_or_above_the_floor() {
        assert_eq!(check_at_least("n", 4096, 4096), 4096);
        assert_eq!(check_at_least("n", 4097, 4096), 4097);
    }

    #[test]
    fn panics_naming_the_value_and_the_floor() {
        let message = panic_message(|| {
            let _ = check_at_least("max_frame_bytes", 512, 4096);
        });
        assert_eq!(message, "max_frame_bytes is 512; expected at least 4096");
    }

    #[test]
    fn checked_accepts_a_value_at_or_above_the_floor() {
        assert_eq!(checked_at_least("n", 4096, 4096), Ok(4096));
    }

    #[test]
    fn checked_names_the_value_and_the_floor_without_panicking() {
        assert_eq!(
            checked_at_least("max_frame_bytes", 512, 4096),
            Err("max_frame_bytes is 512; expected at least 4096".to_string())
        );
    }
}
