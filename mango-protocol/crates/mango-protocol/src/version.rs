//! Wire version and the negotiation rule of the specification's §5.2.

use serde::{Deserialize, Serialize};

/// Wire version a peer announces in `hello.protocol`.
///
/// `major` says which specification document the peer speaks; `minor` is the
/// highest minor of that major it implements.
///
/// # Example
///
/// ```
/// use mango_protocol::{PROTOCOL_VERSION, ProtocolVersion};
///
/// assert_eq!(PROTOCOL_VERSION, ProtocolVersion { major: 1, minor: 1 });
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "schema", schemars(rename = "protocolVersion"))]
pub struct ProtocolVersion {
    /// Wire major. Peers on different majors refuse each other with close code `4426`.
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::schema::constraints::major")
    )]
    pub major: u32,
    /// Wire minor. Additive only; the session runs at the lower of the two.
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::schema::constraints::non_negative")
    )]
    pub minor: u32,
}

impl ProtocolVersion {
    /// Builds a version without naming the fields.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::ProtocolVersion;
    ///
    /// assert_eq!(ProtocolVersion::new(1, 3).minor, 3);
    /// ```
    #[must_use]
    pub const fn new(major: u32, minor: u32) -> Self {
        Self { major, minor }
    }
}

/// The wire version this crate speaks.
pub const PROTOCOL_VERSION: ProtocolVersion = ProtocolVersion::new(1, 1);

/// Outcome of comparing the local and the remote `hello.protocol`.
///
/// # Example
///
/// ```
/// use mango_protocol::{Negotiation, ProtocolVersion, negotiate};
///
/// let outcome = negotiate(ProtocolVersion::new(1, 5), ProtocolVersion::new(1, 2));
/// assert_eq!(outcome, Negotiation::Compatible { effective_minor: 2 });
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Negotiation {
    /// The majors match; the session runs at `effective_minor`.
    Compatible {
        /// The lower of the two announced minors.
        effective_minor: u32,
    },
    /// The majors differ; the receiver closes with `close_code` and sends no request.
    Mismatch {
        /// Always [`crate::close::close_codes::PROTOCOL_MISMATCH`].
        close_code: u16,
    },
}

impl Negotiation {
    /// The effective minor, or `None` when the majors did not match.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::{ProtocolVersion, negotiate};
    ///
    /// let local = ProtocolVersion::new(1, 0);
    /// assert_eq!(negotiate(local, ProtocolVersion::new(2, 0)).effective_minor(), None);
    /// ```
    #[must_use]
    pub const fn effective_minor(self) -> Option<u32> {
        match self {
            Self::Compatible { effective_minor } => Some(effective_minor),
            Self::Mismatch { .. } => None,
        }
    }
}

/// Applies §5.2: equal majors run at the lower minor, different majors are a mismatch.
///
/// # Example
///
/// ```
/// use mango_protocol::{Negotiation, ProtocolVersion, negotiate};
///
/// let mismatch = negotiate(ProtocolVersion::new(1, 0), ProtocolVersion::new(2, 0));
/// assert_eq!(mismatch, Negotiation::Mismatch { close_code: 4426 });
/// ```
#[must_use]
pub fn negotiate(local: ProtocolVersion, remote: ProtocolVersion) -> Negotiation {
    if local.major != remote.major {
        return Negotiation::Mismatch {
            close_code: crate::close::close_codes::PROTOCOL_MISMATCH,
        };
    }
    Negotiation::Compatible {
        effective_minor: local.minor.min(remote.minor),
    }
}

#[cfg(test)]
mod tests {
    use super::{Negotiation, PROTOCOL_VERSION, ProtocolVersion, negotiate};

    #[test]
    fn crate_speaks_wire_one_one() {
        assert_eq!(PROTOCOL_VERSION, ProtocolVersion::new(1, 1));
    }

    #[test]
    fn equal_minors_negotiate_that_minor() {
        let outcome = negotiate(ProtocolVersion::new(1, 0), ProtocolVersion::new(1, 0));
        assert_eq!(outcome, Negotiation::Compatible { effective_minor: 0 });
    }

    #[test]
    fn a_newer_remote_is_capped_at_the_local_minor() {
        let outcome = negotiate(ProtocolVersion::new(1, 0), ProtocolVersion::new(1, 3));
        assert_eq!(outcome, Negotiation::Compatible { effective_minor: 0 });
    }

    #[test]
    fn a_newer_local_is_capped_at_the_remote_minor() {
        let outcome = negotiate(ProtocolVersion::new(1, 5), ProtocolVersion::new(1, 2));
        assert_eq!(outcome, Negotiation::Compatible { effective_minor: 2 });
    }

    #[test]
    fn different_majors_mismatch_with_4426_in_both_directions() {
        let higher = negotiate(ProtocolVersion::new(1, 0), ProtocolVersion::new(2, 0));
        let lower = negotiate(ProtocolVersion::new(2, 1), ProtocolVersion::new(1, 9));
        assert_eq!(higher, Negotiation::Mismatch { close_code: 4426 });
        assert_eq!(lower, Negotiation::Mismatch { close_code: 4426 });
    }

    #[test]
    fn effective_minor_is_none_on_a_mismatch() {
        let outcome = negotiate(ProtocolVersion::new(1, 0), ProtocolVersion::new(2, 0));
        assert_eq!(outcome.effective_minor(), None);
    }

    #[test]
    fn round_trips_as_json() {
        let text = serde_json::to_string(&ProtocolVersion::new(1, 7)).expect("serialises");
        assert_eq!(text, r#"{"major":1,"minor":7}"#);
        let back: ProtocolVersion = serde_json::from_str(&text).expect("deserialises");
        assert_eq!(back, ProtocolVersion::new(1, 7));
    }
}
