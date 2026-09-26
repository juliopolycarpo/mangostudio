//! The runtime's operator diagnostic channel.
//!
//! stdout carries the protocol on the stdio transport, so anything meant for
//! a human is one `mangostudio-runtime: <event> <json>` line on stderr, the
//! shape `writeRuntimeDiagnostic` wrote in the TypeScript runtime. The hub
//! keeps a bounded tail of a spawned runtime's stderr, so a caller that can
//! repeat a diagnostic deduplicates it before writing.
//!
//! The text is unredacted by design: never pass credentials or tool
//! arguments.

use serde_json::Value;

/// Where diagnostic lines go. [`StderrDiagnostics`] in production; tests
/// substitute a recording fake.
pub(crate) trait DiagnosticSink: Send + Sync {
    /// Writes one complete line, without its trailing newline.
    fn write_line(&self, line: &str);
}

/// The production [`DiagnosticSink`]: the process's stderr.
pub(crate) struct StderrDiagnostics;

impl DiagnosticSink for StderrDiagnostics {
    fn write_line(&self, line: &str) {
        eprintln!("{line}");
    }
}

/// Formats one diagnostic line: the event name, then its detail as compact
/// JSON when the detail is a non-empty object.
///
/// # Example
///
/// ```ignore
/// let line = diagnostic_line("version_probe_failed", &json!({ "executable": "/usr/bin/gh" }));
/// assert_eq!(line, r#"mangostudio-runtime: version_probe_failed {"executable":"/usr/bin/gh"}"#);
/// ```
pub(crate) fn diagnostic_line(event: &str, detail: &Value) -> String {
    let empty = detail.as_object().is_some_and(serde_json::Map::is_empty);
    if detail.is_null() || empty {
        return format!("mangostudio-runtime: {event}");
    }
    format!("mangostudio-runtime: {event} {detail}")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::diagnostic_line;

    #[test]
    fn a_detail_is_appended_as_compact_json() {
        assert_eq!(
            diagnostic_line(
                "version_probe_failed",
                &json!({ "executable": "/usr/bin/gh" })
            ),
            r#"mangostudio-runtime: version_probe_failed {"executable":"/usr/bin/gh"}"#
        );
    }

    #[test]
    fn an_empty_detail_writes_the_event_alone() {
        assert_eq!(
            diagnostic_line("stopped", &json!({})),
            "mangostudio-runtime: stopped"
        );
        assert_eq!(
            diagnostic_line("stopped", &serde_json::Value::Null),
            "mangostudio-runtime: stopped"
        );
    }
}
