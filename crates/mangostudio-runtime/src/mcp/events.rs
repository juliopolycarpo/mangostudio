//! Where the MCP service's out-of-band output goes: `mcp.session` / `mcp.elicitation` events to
//! the hub, and operator diagnostics to stderr (never stdout, which carries protocol frames in
//! `stdio` mode).

use mango_protocol::session::{EventInput, Session};
use serde_json::{Map, Value};

/// `mcp.session`: a session dropped or its tool list changed.
pub(crate) const SESSION_TOPIC: &str = "mcp.session";
/// `mcp.elicitation`: a server's mid-call form request.
pub(crate) const ELICITATION_TOPIC: &str = "mcp.elicitation";

/// Publishes events and records diagnostics; tests implement it with a named fake.
pub(crate) trait McpEvents: Send + Sync {
    /// Publishes one event; `false` means the hub session cannot carry it.
    fn emit(&self, topic: &str, payload: Value) -> bool;
    /// Writes one operator diagnostic. Only ids go here, never user text.
    fn diagnostic(&self, event: &str, detail: &[(&str, &str)]);
}

/// Production sink: the connection's hub session, through the contract's event check.
///
/// # Example
/// ```ignore
/// let events = SessionEvents(context.session().clone());
/// events.emit(SESSION_TOPIC, json!({"serverId": "a", "change": "closed"}));
/// ```
pub(crate) struct SessionEvents(pub Session);

impl McpEvents for SessionEvents {
    fn emit(&self, topic: &str, payload: Value) -> bool {
        let input = EventInput {
            topic: topic.to_owned(),
            payload,
            stream_id: None,
            end: false,
        };
        crate::event_check::checked_emit(&self.0, input).unwrap_or(false)
    }

    fn diagnostic(&self, event: &str, detail: &[(&str, &str)]) {
        eprintln!("{}", diagnostic_line(event, detail));
    }
}

/// The TypeScript host's `writeRuntimeDiagnostic` line: `mangostudio-runtime: <event> {json}`.
pub(crate) fn diagnostic_line(event: &str, detail: &[(&str, &str)]) -> String {
    if detail.is_empty() {
        return format!("mangostudio-runtime: {event}");
    }
    let detail = detail
        .iter()
        .map(|(key, value)| ((*key).to_owned(), Value::String((*value).to_owned())))
        .collect::<Map<_, _>>();
    format!("mangostudio-runtime: {event} {}", Value::Object(detail))
}

#[cfg(test)]
pub(crate) mod fakes {
    use std::sync::Mutex;

    use super::*;

    /// Named fake: records what was published and whether the hub "carried" it.
    pub(crate) struct RecordingEvents {
        pub deliverable: bool,
        pub events: Mutex<Vec<(String, Value)>>,
        pub diagnostics: Mutex<Vec<String>>,
    }

    impl RecordingEvents {
        pub(crate) fn new(deliverable: bool) -> Self {
            Self {
                deliverable,
                events: Mutex::default(),
                diagnostics: Mutex::default(),
            }
        }

        pub(crate) fn published(&self, topic: &str) -> Vec<Value> {
            self.events
                .lock()
                .unwrap()
                .iter()
                .filter(|(published, _)| published == topic)
                .map(|(_, payload)| payload.clone())
                .collect()
        }
    }

    impl McpEvents for RecordingEvents {
        fn emit(&self, topic: &str, payload: Value) -> bool {
            self.events
                .lock()
                .unwrap()
                .push((topic.to_owned(), payload));
            self.deliverable
        }

        fn diagnostic(&self, event: &str, detail: &[(&str, &str)]) {
            self.diagnostics
                .lock()
                .unwrap()
                .push(diagnostic_line(event, detail));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostics_use_the_typescript_line_shape() {
        assert_eq!(
            diagnostic_line(
                "mcp_elicitation_unobserved",
                &[("serverId", "s"), ("toolCallId", "c")]
            ),
            r#"mangostudio-runtime: mcp_elicitation_unobserved {"serverId":"s","toolCallId":"c"}"#
        );
        assert_eq!(diagnostic_line("bare", &[]), "mangostudio-runtime: bare");
    }
}
