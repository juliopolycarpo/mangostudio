//! Test-only ownership without Supervisor's automatic finalization on root exit.
use std::io;
use std::time::Duration;

use super::fixture_cleanup::FixtureOwner;
use super::{ProcessRequest, windows_job};

/// Retains an atomic kill-on-close Job through receipt capture, even after root exit.
/// Usage: `let mut fixture = WindowsFixture::spawn(&request)?; fixture.start()?;`.
pub(crate) struct WindowsFixture {
    child: windows_job::WindowsJobChild,
    runtime: tokio::runtime::Runtime,
}

impl WindowsFixture {
    /// Spawn suspended inside the owned Job; release only inside the cleanup scope.
    /// Usage: `let fixture = WindowsFixture::spawn(&request)?;`.
    pub(crate) fn spawn(request: &ProcessRequest) -> io::Result<Self> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let child = {
            let _entered = runtime.enter();
            windows_job::spawn(request)?
        };
        Ok(Self { child, runtime })
    }

    /// Observe the retained root handle's PID without granting PID cleanup authority.
    /// Usage: `let root = fixture.id();`.
    pub(crate) fn id(&self) -> u32 {
        self.child
            .id()
            .expect("Windows fixture owns its root handle")
    }

    /// Release the suspended root while its Job is already owned by the cleanup scope.
    /// Usage: `inspect_then_cleanup(&mut fixture, |fixture| fixture.start())?;`.
    pub(crate) fn start(&mut self) -> io::Result<()> {
        self.child.release_start()
    }
}

impl FixtureOwner for WindowsFixture {
    fn finish(&mut self) -> io::Result<()> {
        self.child.force()?;
        // One deadline covers the root handle and Job query, without a blocking waiter or
        // cloned Job handle outliving timeout. Dropping this owner retains kill-on-close.
        self.runtime.block_on(async {
            tokio::time::timeout(Duration::from_secs(5), async {
                self.child.wait_target().await?;
                while !self.child.fixture_job_empty()? {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                Ok(())
            })
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "expected owned Windows fixture root and Job empty within 5s | received unsettled"))?
        })
    }
}
