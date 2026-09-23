//! A long-lived child with piped stdio under the same owner as every other child.
//!
//! [`super::ProcessSpawner`] owns bounded commands: it captures stdout into a capped buffer and
//! applies a deadline, so it cannot back a process whose stdio is a live protocol stream. A
//! [`PipeChild`] is the stdio sibling of [`super::PtyChild`]: the target still starts behind the
//! Unix guardian's start gate (or suspended inside a kill-on-close Windows Job), and its owner
//! still has to force, wait, finalize, and wait for the tree. Only the stdio policy differs.

use std::io;
use std::process::ExitStatus;

use tokio::io::{AsyncRead, AsyncWrite};

use super::{ProcessRequest, ProcessStdin};

type Reader = Box<dyn AsyncRead + Send + Unpin>;
type Writer = Box<dyn AsyncWrite + Send + Unpin>;

/// A guardian- or Job-owned child whose stdin, stdout, and stderr are pipes.
pub(crate) enum PipeChild {
    #[cfg(unix)]
    Unix(super::unix_guardian::GuardianChild),
    #[cfg(windows)]
    Windows(super::windows_job::WindowsJobChild),
}

impl PipeChild {
    /// Starts `request` held behind its start gate, with a stdin pipe kept open for the caller.
    ///
    /// Both platform spawners allocate a stdin pipe for any [`ProcessStdin::Bytes`] request and
    /// leave writing it to the owner; an empty payload is how this module asks for that pipe
    /// without adding a variant to the public stdin enum. Nothing ever writes the empty payload,
    /// so the pipe stays open until the caller drops the writer returned by [`Self::take_stdin`].
    ///
    /// # Example
    /// ```ignore
    /// let mut child = PipeChild::spawn(&ProcessRequest::new("cat", Vec::<String>::new()))?;
    /// child.wait_ready().await?;
    /// child.release_start()?;
    /// ```
    pub(crate) fn spawn(request: &ProcessRequest) -> io::Result<Self> {
        let mut request = request.clone();
        request.stdin = ProcessStdin::Bytes(Vec::new());
        #[cfg(unix)]
        {
            super::unix_guardian::spawn(&request).map(Self::Unix)
        }
        #[cfg(windows)]
        {
            super::windows_job::spawn(&request).map(Self::Windows)
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = request;
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "an owned stdio child requires Unix or Windows",
            ))
        }
    }

    pub(crate) async fn wait_ready(&mut self) -> io::Result<()> {
        match self {
            #[cfg(unix)]
            Self::Unix(child) => child.wait_ready().await,
            #[cfg(windows)]
            Self::Windows(child) => child.wait_ready().await,
        }
    }

    pub(crate) fn release_start(&mut self) -> io::Result<()> {
        match self {
            #[cfg(unix)]
            Self::Unix(child) => child.release_start(),
            #[cfg(windows)]
            Self::Windows(child) => child.release_start(),
        }
    }

    pub(crate) async fn wait_exec(&mut self) -> io::Result<()> {
        match self {
            #[cfg(unix)]
            Self::Unix(child) => child.wait_exec().await,
            #[cfg(windows)]
            Self::Windows(child) => child.wait_exec().await,
        }
    }

    pub(crate) fn abort_start(&mut self) {
        match self {
            #[cfg(unix)]
            Self::Unix(child) => child.abort_start(),
            #[cfg(windows)]
            Self::Windows(_) => {}
        }
    }

    pub(crate) fn take_stdin(&mut self) -> Option<Writer> {
        match self {
            #[cfg(unix)]
            Self::Unix(child) => child.take_stdin(),
            #[cfg(windows)]
            Self::Windows(child) => child.take_stdin(),
        }
    }

    pub(crate) fn take_stdout(&mut self) -> Option<Reader> {
        match self {
            #[cfg(unix)]
            Self::Unix(child) => child.take_stdout(),
            #[cfg(windows)]
            Self::Windows(child) => child.take_stdout(),
        }
    }

    pub(crate) fn take_stderr(&mut self) -> Option<Reader> {
        match self {
            #[cfg(unix)]
            Self::Unix(child) => child.take_stderr(),
            #[cfg(windows)]
            Self::Windows(child) => child.take_stderr(),
        }
    }

    /// Asks the target group to exit (SIGTERM); Windows Jobs report `Unsupported`.
    pub(crate) fn interrupt(&mut self) -> io::Result<()> {
        match self {
            #[cfg(unix)]
            Self::Unix(child) => child.interrupt(),
            #[cfg(windows)]
            Self::Windows(child) => child.interrupt(),
        }
    }

    pub(crate) fn force(&mut self) -> io::Result<()> {
        match self {
            #[cfg(unix)]
            Self::Unix(child) => child.force(),
            #[cfg(windows)]
            Self::Windows(child) => child.force(),
        }
    }

    pub(crate) async fn wait_target(&mut self) -> io::Result<ExitStatus> {
        match self {
            #[cfg(unix)]
            Self::Unix(child) => child.wait_target().await,
            #[cfg(windows)]
            Self::Windows(child) => child.wait_target().await,
        }
    }

    pub(crate) fn finalize(&mut self) -> io::Result<()> {
        match self {
            #[cfg(unix)]
            Self::Unix(child) => child.finalize(),
            #[cfg(windows)]
            Self::Windows(child) => child.finalize(),
        }
    }

    /// Waits until the platform owner reports the whole tree gone.
    pub(crate) async fn wait_tree(&mut self) -> io::Result<()> {
        match self {
            #[cfg(unix)]
            Self::Unix(child) => child.wait_guardian().await,
            #[cfg(windows)]
            Self::Windows(child) => child.wait_guardian().await,
        }
    }
}
