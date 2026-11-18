//! Drives the production PTY spawner end to end over a real PTY master: bytes through the master,
//! resize observed by the child, hangup and exit when the child ends, and descriptor release on
//! close.
//!
//! This is its own test binary so the descriptor counts see only this file's PTYs; the tests
//! inside it still share a process, so each holds `REAL_PTY_TEST` for its whole run.
//!
//! Every deadline is a hang bound that names the condition that never held.

#![cfg(unix)]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use mangostudio_runtime::subprocess::AlwaysAllow;
use mangostudio_runtime::terminal::pty::{
    DefaultPtySpawner, PtyExit, PtyHandle, PtyRequest, PtySpawner,
};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

static REAL_PTY_TEST: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Upper bound for any single wait; a healthy PTY child answers in milliseconds.
const HANG_BOUND: Duration = Duration::from_secs(15);

/// One running terminal and what it reported so far.
struct RunningTerminal {
    handle: Arc<dyn PtyHandle>,
    output: Arc<Mutex<Vec<u8>>>,
    exit: oneshot::Receiver<PtyExit>,
    exits_reported: Arc<Mutex<u32>>,
}

impl RunningTerminal {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.output.lock().unwrap()).into_owned()
    }

    /// Waits until the output contains `needle`.
    async fn wait_for_output(&self, needle: &str) {
        let waited = tokio::time::timeout(HANG_BOUND, async {
            while !self.text().contains(needle) {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await;
        assert!(
            waited.is_ok(),
            "(terminal output): expected {needle:?} within {HANG_BOUND:?} | received: {:?}",
            self.text()
        );
    }

    /// Waits for the exit callback.
    async fn wait_for_exit(&mut self) -> PtyExit {
        match tokio::time::timeout(HANG_BOUND, &mut self.exit).await {
            Ok(Ok(exit)) => exit,
            Ok(Err(_)) => panic!("(terminal exit): expected an exit report | received: none sent"),
            Err(_) => panic!(
                "(terminal exit): expected an exit report within {HANG_BOUND:?} | received: the \
                 child never ended; output so far {:?}",
                self.text()
            ),
        }
    }
}

async fn start_terminal(script: &str, cols: u16, rows: u16) -> RunningTerminal {
    let output = Arc::new(Mutex::new(Vec::new()));
    let collected = Arc::clone(&output);
    let exits_reported = Arc::new(Mutex::new(0_u32));
    let counted = Arc::clone(&exits_reported);
    let (exit_tx, exit) = oneshot::channel();
    let exit_tx = Arc::new(Mutex::new(Some(exit_tx)));
    let request = PtyRequest::new("/bin/sh", ["-c", script], cols, rows);
    let handle = DefaultPtySpawner
        .spawn(
            request,
            Arc::new(AlwaysAllow),
            Arc::new(move |chunk| collected.lock().unwrap().extend_from_slice(chunk)),
            Arc::new(move |exit| {
                *counted.lock().unwrap() += 1;
                if let Some(sender) = exit_tx.lock().unwrap().take() {
                    let _ = sender.send(exit);
                }
            }),
            CancellationToken::new(),
        )
        .await
        .unwrap_or_else(|error| {
            panic!("(PTY start): expected a running terminal | received: {error:?}")
        });
    RunningTerminal {
        handle,
        output,
        exit,
        exits_reported,
    }
}

/// Input written through the master reaches the child, and the child's answer returns through
/// the master. The line discipline echoes the typed line before the child prints its own.
#[tokio::test]
async fn pty_master_carries_input_to_the_child_and_output_back() {
    let _serial = REAL_PTY_TEST.lock().await;
    let mut terminal = start_terminal(r#"read line; printf '<%s>\n' "$line""#, 80, 24).await;

    terminal
        .handle
        .write(b"hello\n".to_vec())
        .await
        .expect("input is written to the master");
    terminal.wait_for_output("<hello>").await;

    let exit = terminal.wait_for_exit().await;
    assert_eq!(
        exit,
        PtyExit {
            code: Some(0),
            signal: None
        },
        "(terminal exit): expected a clean exit after the child printed its answer"
    );
}

/// A resize on the master is what the child's terminal reports, once per resize, in order.
#[tokio::test]
async fn pty_resize_is_observed_by_the_child_through_stty_size() {
    let _serial = REAL_PTY_TEST.lock().await;
    let terminal =
        start_terminal(r#"stty size; read a; stty size; read b; stty size"#, 90, 30).await;
    terminal.wait_for_output("30 90").await;

    terminal.handle.resize(101, 43).await.expect("first resize");
    terminal
        .handle
        .write(b"go\n".to_vec())
        .await
        .expect("child continues");
    terminal.wait_for_output("43 101").await;

    terminal
        .handle
        .resize(132, 50)
        .await
        .expect("second resize");
    terminal
        .handle
        .write(b"go\n".to_vec())
        .await
        .expect("child continues");
    terminal.wait_for_output("50 132").await;

    let text = terminal.text();
    let positions: Vec<_> = ["30 90", "43 101", "50 132"]
        .map(|size| text.find(size).map(|at| (size, at)))
        .into_iter()
        .collect();
    let in_order = positions
        .windows(2)
        .all(|pair| matches!((pair[0], pair[1]), (Some((_, a)), Some((_, b))) if a < b));
    assert!(
        in_order,
        "(terminal output): expected sizes 30 90, 43 101, 50 132 in order | received: {text:?}"
    );
}

/// When the child exits, the master reports the hangup, delivers everything the child wrote
/// before it, and the exit callback runs exactly once with the child's status.
#[tokio::test]
async fn pty_hangup_delivers_pending_output_and_reports_the_exit_once() {
    let _serial = REAL_PTY_TEST.lock().await;
    let mut terminal = start_terminal("printf 'last-words'; exit 3", 80, 24).await;

    let exit = terminal.wait_for_exit().await;

    assert_eq!(
        exit,
        PtyExit {
            code: Some(3),
            signal: None
        },
        "(terminal exit): expected code 3 and no signal"
    );
    assert!(
        terminal.text().contains("last-words"),
        "(terminal output): expected the output written before exit when the exit is reported | \
         received: {:?}",
        terminal.text()
    );
    terminal
        .handle
        .close()
        .await
        .expect("closing an exited terminal is idempotent");
    assert_eq!(
        *terminal.exits_reported.lock().unwrap(),
        1,
        "(terminal exit): expected exactly one exit report after close"
    );
    let late_write = terminal.handle.write(b"late".to_vec()).await;
    assert!(
        late_write.is_err(),
        "(terminal write): expected an error writing to a closed terminal | received: Ok"
    );
}

/// Counts the descriptors this process holds on any PTY, master (`/dev/ptmx`) or slave
/// (`/dev/pts/N`), from `/proc/self/fd`.
#[cfg(any(target_os = "linux", target_os = "android"))]
fn pty_descriptors_held() -> usize {
    std::fs::read_dir("/proc/self/fd")
        .expect("read /proc/self/fd")
        .filter_map(Result::ok)
        .filter_map(|entry| std::fs::read_link(entry.path()).ok())
        .filter(|target| target.as_os_str() == "/dev/ptmx" || target.starts_with("/dev/pts/"))
        .count()
}

/// Waits for the PTY descriptor count to settle at `baseline`. The reader and writer tasks drop
/// their descriptors on the runtime a moment after `close` resolves, so this polls to a bound.
#[cfg(any(target_os = "linux", target_os = "android"))]
async fn assert_pty_descriptors_released(baseline: usize, after: &str) {
    let mut held = pty_descriptors_held();
    let waited = tokio::time::timeout(HANG_BOUND, async {
        while held != baseline {
            tokio::time::sleep(Duration::from_millis(5)).await;
            held = pty_descriptors_held();
        }
    })
    .await;
    assert!(
        waited.is_ok(),
        "(PTY descriptors): expected {baseline} held after {after} within {HANG_BOUND:?} | \
         received: {held}"
    );
}

/// Closing a live terminal and letting one exit on its own both release every PTY descriptor,
/// including the master duplicates the reader, writer, and resize path each hold. Repeating the
/// cycle makes a one-descriptor leak per terminal visible as growth.
#[cfg(any(target_os = "linux", target_os = "android"))]
#[tokio::test]
async fn pty_descriptors_are_released_after_close_and_after_exit() {
    let _serial = REAL_PTY_TEST.lock().await;
    let baseline = pty_descriptors_held();

    for round in 0..3 {
        let terminal = start_terminal("read line; read line", 80, 24).await;
        assert!(
            pty_descriptors_held() > baseline,
            "(PTY descriptors): expected the running terminal to hold PTY descriptors | \
             received: {} against baseline {baseline}",
            pty_descriptors_held()
        );
        terminal.handle.close().await.expect("terminal closes");
        assert_pty_descriptors_released(baseline, &format!("closing live terminal {round}")).await;

        let mut exiting = start_terminal("exit 0", 80, 24).await;
        exiting.wait_for_exit().await;
        exiting
            .handle
            .close()
            .await
            .expect("exited terminal closes");
        assert_pty_descriptors_released(baseline, &format!("exited terminal {round}")).await;
    }
}
