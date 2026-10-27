//! Test-only cleanup ordering: sample the operation before the owned fallback runs.
use std::io;

/// An owned fixture tree; `finish` must settle every process, including descendants.
pub(crate) trait FixtureOwner {
    /// Settle the owned root and descendants before returning.
    /// Usage: `owner.finish()?;`.
    fn finish(&mut self) -> io::Result<()>;
}

/// Preserve the operation's verdict before executing fallback cleanup.
/// Usage: `inspect_then_cleanup(&mut owner, |owner| inspect(owner))?`.
pub(crate) fn inspect_then_cleanup<Owner: FixtureOwner, T>(
    owner: &mut Owner,
    inspect: impl FnOnce(&mut Owner) -> io::Result<T>,
) -> io::Result<T> {
    let result = inspect(owner);
    let cleanup = owner.finish();
    match (result, cleanup) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(primary), Err(cleanup)) => Err(io::Error::other(FixtureFailure { primary, cleanup })),
    }
}

#[derive(Debug)]
struct FixtureFailure {
    primary: io::Error,
    cleanup: io::Error,
}

impl std::fmt::Display for FixtureFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "{}; owned fixture cleanup also failed: {}",
            self.primary, self.cleanup
        )
    }
}

impl std::error::Error for FixtureFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.primary)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeFixtureTree {
        root_alive: bool,
        descendant_alive: bool,
        cleanup_fails: bool,
    }

    impl FixtureOwner for FakeFixtureTree {
        fn finish(&mut self) -> io::Result<()> {
            self.root_alive = false;
            self.descendant_alive = false;
            if self.cleanup_fails {
                return Err(io::Error::other("named Job query failure"));
            }
            Ok(())
        }
    }

    #[test]
    fn early_query_failure_settles_the_entire_owned_fixture() {
        let mut owner = FakeFixtureTree {
            root_alive: true,
            descendant_alive: true,
            cleanup_fails: false,
        };
        let primary = io::Error::new(io::ErrorKind::InvalidData, "named CIM readiness failure");
        let result: io::Result<()> = inspect_then_cleanup(&mut owner, |_| Err(primary));
        let error = result.unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert_eq!(error.to_string(), "named CIM readiness failure");
        assert!(
            !owner.root_alive,
            "expected owned roots: 0 | received alive"
        );
        assert!(
            !owner.descendant_alive,
            "expected owned descendants: 0 | received alive"
        );
    }

    #[test]
    fn fallback_cannot_change_a_rejected_surviving_receipt_to_success() {
        let mut owner = FakeFixtureTree {
            root_alive: true,
            descendant_alive: true,
            cleanup_fails: false,
        };
        let result: io::Result<()> = inspect_then_cleanup(&mut owner, |owner| {
            assert!(
                owner.descendant_alive,
                "expected live descendant before fallback"
            );
            Err(io::Error::other("expected survivors: 0 | received: 1"))
        });
        assert_eq!(
            result.unwrap_err().to_string(),
            "expected survivors: 0 | received: 1"
        );
        assert!(!owner.descendant_alive);
    }

    #[test]
    fn cleanup_failure_retains_the_primary_cause() {
        let mut owner = FakeFixtureTree {
            root_alive: true,
            descendant_alive: true,
            cleanup_fails: true,
        };
        let result: io::Result<()> = inspect_then_cleanup(&mut owner, |_| {
            Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "named setup failure",
            ))
        });
        let error = result.unwrap_err();
        assert!(error.to_string().contains(
            "named setup failure; owned fixture cleanup also failed: named Job query failure"
        ));
        assert_eq!(
            error.get_ref().unwrap().source().unwrap().to_string(),
            "named setup failure"
        );
    }

    #[test]
    fn successful_body_still_requires_successful_cleanup() {
        let mut owner = FakeFixtureTree {
            root_alive: true,
            descendant_alive: true,
            cleanup_fails: true,
        };
        assert_eq!(
            inspect_then_cleanup(&mut owner, |_| Ok(()))
                .unwrap_err()
                .to_string(),
            "named Job query failure"
        );
        owner.cleanup_fails = false;
        assert_eq!(
            inspect_then_cleanup(&mut owner, |_| Ok("captured receipt")).unwrap(),
            "captured receipt"
        );
    }
}
