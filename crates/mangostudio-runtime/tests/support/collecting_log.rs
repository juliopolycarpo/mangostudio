//! [`CollectingLog`]: a transport log sink that records what it was told.

use std::sync::{Arc, Mutex};

use tokio::sync::Notify;

/// A named log fake that actually records what it was told, rather than a
/// closure that discards it — so a test can assert on the message a code
/// path produces, not just that some path or other ran.
#[derive(Clone, Default)]
pub struct CollectingLog {
    messages: Arc<Mutex<Vec<String>>>,
    appended: Arc<Notify>,
}

impl CollectingLog {
    pub fn new() -> Self {
        Self::default()
    }

    /// The `log` callback a transport takes, appending to this log.
    pub fn sink(&self) -> impl Fn(&str) + Clone + Send + Sync + 'static {
        let messages = Arc::clone(&self.messages);
        let appended = Arc::clone(&self.appended);
        move |message: &str| {
            messages.lock().unwrap().push(message.to_string());
            appended.notify_waiters();
        }
    }

    /// Every message recorded so far, in order.
    pub fn messages(&self) -> Vec<String> {
        self.messages.lock().unwrap().clone()
    }

    /// Resolves once a recorded message contains `needle` — the runtime's own
    /// signal that a code path reached the point that logs it. Woken by each
    /// append rather than polled, so it waits exactly as long as the event
    /// takes; a caller bounds it only against a hang.
    ///
    /// # Example
    ///
    /// ```ignore
    /// within("the release log line", log.wait_for("Hub connection ended.")).await;
    /// ```
    pub async fn wait_for(&self, needle: &str) {
        loop {
            // Registered before the check, so an append between the check and
            // the await still wakes this waiter.
            let appended = self.appended.notified();
            tokio::pin!(appended);
            appended.as_mut().enable();
            if self
                .messages
                .lock()
                .unwrap()
                .iter()
                .any(|message| message.contains(needle))
            {
                return;
            }
            appended.await;
        }
    }
}
