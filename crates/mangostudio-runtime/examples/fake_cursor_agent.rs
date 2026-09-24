//! A stand-in `cursor-agent` for the compiled-runtime qualification suite.
//!
//! The hub-to-binary tests need a vendor the real runtime can discover, launch
//! through its own guarded launcher and drive over ACP, on every platform the
//! suite runs on, without a login. This binary is that vendor: it pipes its
//! real stdio through the SDK's own named fake, `FakeAcpAgent`, so the wire it
//! speaks is the one the SDK's harness is already proven against rather than a
//! second hand-written ACP peer.
//!
//! Every turn streams the fake's default updates (a command catalog, a thought,
//! `hello`, a completed tool call, usage) and then asks one permission question
//! before it ends. An allow ends the turn with `end_turn`; a `session/cancel`
//! waits for the question to be withdrawn and ends it `cancelled`, as ACP
//! requires. `--version` prints a Cursor-shaped version so probing accepts it.
//!
//! Built by `cargo build -p mangostudio-runtime --example fake_cursor_agent`,
//! in its own invocation: building it alongside the runtime binary would unify
//! the SDK's `testing` feature into the binary under qualification.
//!
//! ```text
//! $ fake_cursor_agent --version
//! 2026.09.10-fd3934a
//! ```

use std::path::PathBuf;

use mango_agent_acp::testing::{Approval, FakeAcpAgent};
use mango_external_agents::testing::FakeLauncher;
use mango_external_agents::{LaunchSpec, ProcessLauncher};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

/// The version the qualification suite expects discovery to report.
const VERSION: &str = "2026.09.10-fd3934a";

#[tokio::main(flavor = "current_thread")]
async fn main() -> std::process::ExitCode {
    if std::env::args().nth(1).as_deref() == Some("--version") {
        println!("{VERSION}");
        return std::process::ExitCode::SUCCESS;
    }
    match serve().await {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("fake_cursor_agent: {error}");
            std::process::ExitCode::FAILURE
        }
    }
}

/// Relays stdin lines into the scripted agent and its output to stdout until
/// the client closes stdin.
async fn serve() -> Result<(), Box<dyn std::error::Error>> {
    let launcher = FakeLauncher::new();
    launcher.push(
        FakeAcpAgent::new()
            .asking_for_approval(Approval::Once)
            .process(),
    );
    let child = launcher
        .spawn(LaunchSpec {
            argv: vec!["cursor-agent".to_owned(), "acp".to_owned()],
            cwd: PathBuf::from("."),
            env: Default::default(),
            stdin: true,
            hide_window: false,
        })
        .await?;
    let mut agent_stdin = child.stdin.ok_or("the scripted agent has no stdin")?;
    let mut agent_stdout = child.stdout;

    let input = tokio::spawn(async move {
        let mut lines = BufReader::new(tokio::io::stdin()).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if agent_stdin
                .write_all(format!("{line}\n").as_bytes())
                .await
                .is_err()
            {
                break;
            }
        }
        let _ = agent_stdin.close().await;
    });

    let mut stdout = tokio::io::stdout();
    while let Some(chunk) = agent_stdout.next_chunk().await? {
        stdout.write_all(&chunk).await?;
        stdout.flush().await?;
    }
    input.abort();
    Ok(())
}
