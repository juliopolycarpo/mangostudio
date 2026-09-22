//! [`CollectingLog`]: a transport log sink that records what it was told.

use std::sync::{Arc, Mutex};

/// A named log fake that actually records what it was told, rather than a
/// closure that discards it — so a test can assert on the message a code
/// path produces, not just that some path or other ran.
#[derive(Clone, Default)]
pub struct CollectingLog {
    messages: Arc<Mutex<Vec<String>>>,
}

impl CollectingLog {
    pub fn new() -> Self {
        Self::default()
    }

    /// The `log` callback a transport takes, appending to this log.
    pub fn sink(&self) -> impl Fn(&str) + Clone + Send + Sync + 'static {
        let messages = Arc::clone(&self.messages);
        move |message: &str| messages.lock().unwrap().push(message.to_string())
    }

    /// Every message recorded so far, in order.
    pub fn messages(&self) -> Vec<String> {
        self.messages.lock().unwrap().clone()
    }
}
