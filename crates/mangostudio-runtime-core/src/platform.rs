//! The host's platform name, in Node's spelling.

/// Maps [`std::env::consts::OS`] to `process.platform`'s own spelling: the wire and the
/// TypeScript host call this machine `darwin` and `win32`, never `macos` and `windows`.
///
/// It sits below `health` and `probing` because both must agree on what this host calls
/// itself: `health` reports it and `probing` builds its `PathEnv` from it.
#[must_use]
pub fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "linux" => "linux",
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::node_platform;

    #[test]
    fn the_platform_name_is_node_spelling_for_the_host_os() {
        let expected = match std::env::consts::OS {
            "macos" => "darwin",
            "windows" => "win32",
            other => other,
        };
        assert_eq!(
            node_platform(),
            expected,
            "(platform): expected process.platform spelling for {} | received: {}",
            std::env::consts::OS,
            node_platform()
        );
    }
}
