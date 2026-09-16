//! The Windows half of the local socket transport: a named pipe in byte
//! mode, one instance per accepted connection.

use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::io::{ReadHalf, WriteHalf};
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient, NamedPipeServer};

use crate::close::close_codes;
use crate::transports::deadline::{ConnectDeadline, ConnectError, connect_within};
use crate::transports::ndjson::{NdjsonPort, PortCloser};

use super::PeerIdentity;

mod security;

/// `ERROR_PIPE_BUSY`: every instance of the pipe is serving someone else, so
/// the dialler waits for one to free up rather than failing the address.
const ERROR_PIPE_BUSY: i32 = 231;

/// How long a dialler waits before looking for a free pipe instance again.
const BUSY_RETRY: Duration = Duration::from_millis(20);

/// The port a dialled connection produces.
pub type IpcPort = NdjsonPort<ReadHalf<NamedPipeClient>, WriteHalf<NamedPipeClient>>;

/// The port an accepted connection produces. A named pipe's two ends are
/// different kinds of object, unlike a Unix socket's.
pub type IpcServerPort = NdjsonPort<ReadHalf<NamedPipeServer>, WriteHalf<NamedPipeServer>>;

/// Named pipes live in a flat namespace spelled with backslashes; forward
/// slashes are not equivalent (local-socket.md, Addresses).
pub(super) fn address_for(name: &str) -> PathBuf {
    PathBuf::from(format!(r"\\.\pipe\{name}"))
}

/// A listener on a named pipe, and the address it actually bound.
///
/// # Example
///
/// ```no_run
/// # #[tokio::main(flavor = "current_thread")]
/// # async fn main() -> std::io::Result<()> {
/// use mango_protocol::transports::ipc::listen_ipc;
///
/// let mut listener = listen_ipc(r"\\.\pipe\mango-hub").await?;
/// let (_port, _identity) = listener.accept().await?;
/// listener.close().await;
/// # Ok(())
/// # }
/// ```
#[derive(Debug)]
pub struct IpcListener {
    /// The instance waiting for the next client. A named pipe serves one
    /// client per instance, so accepting means handing this one over and
    /// creating the next.
    idle: NamedPipeServer,
    path: PathBuf,
    max_frame_bytes: Option<usize>,
    /// Weak handles to the ports handed out, so shutting down can tell the
    /// sessions still using them. Holding one never keeps a pipe alive.
    accepted: Vec<PortCloser<WriteHalf<NamedPipeServer>>>,
}

impl IpcListener {
    /// The address this listener bound.
    ///
    /// # Example
    ///
    /// ```no_run
    /// # #[tokio::main(flavor = "current_thread")]
    /// # async fn main() -> std::io::Result<()> {
    /// use mango_protocol::transports::ipc::listen_ipc;
    ///
    /// let listener = listen_ipc(r"\\.\pipe\mango-hub").await?;
    /// assert!(listener.path().to_string_lossy().ends_with("mango-hub"));
    /// # Ok(())
    /// # }
    /// ```
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Sets the frame limit every port this listener produces enforces.
    ///
    /// # Panics
    ///
    /// Panics when `max_frame_bytes` is below
    /// [`crate::codec::ndjson::MIN_MAX_FRAME_BYTES`], naming both.
    ///
    /// # Example
    ///
    /// ```no_run
    /// # #[tokio::main(flavor = "current_thread")]
    /// # async fn main() -> std::io::Result<()> {
    /// use mango_protocol::transports::ipc::listen_ipc;
    ///
    /// let listener = listen_ipc(r"\\.\pipe\mango-hub")
    ///     .await?
    ///     .with_max_frame_bytes(1 << 20);
    /// # let _ = listener;
    /// # Ok(())
    /// # }
    /// ```
    #[must_use]
    pub fn with_max_frame_bytes(mut self, max_frame_bytes: usize) -> Self {
        self.max_frame_bytes = Some(crate::codec::limits::check_max_frame_bytes(max_frame_bytes));
        self
    }

    /// Waits for the next client and hands back its port and the identity the
    /// pipe carries.
    ///
    /// # Errors
    ///
    /// Whatever waiting for the client, or creating the instance that will
    /// serve the one after it, failed with.
    pub async fn accept(&mut self) -> io::Result<(IpcServerPort, PeerIdentity)> {
        self.idle.connect().await?;
        // The next client needs an instance of its own, created with the same
        // restriction as the first: a second instance created without one
        // would publish an address anybody could answer on.
        let next = match security::create_owner_only_instance(&self.path, false) {
            Ok(next) => next,
            Err(error) => {
                // A client is already connected to the idle instance. Left
                // alone it would be neither served nor told, and the next
                // `accept` would hand it out as a fresh arrival, because
                // `connect` on an already-connected instance succeeds.
                let _ = self.idle.disconnect();
                return Err(error);
            }
        };
        let connected = std::mem::replace(&mut self.idle, next);

        let identity = PeerIdentity {
            process_id: security::client_process_id(&connected),
            user: None,
        };
        let (reader, writer) = tokio::io::split(connected);
        let port = self.framed(reader, writer);
        // Connections that have since ended are forgotten here rather than
        // accumulating for the life of a long-running listener.
        self.accepted.retain(PortCloser::is_open);
        self.accepted.push(port.closer());
        Ok((port, identity))
    }

    /// Tells every session still open on this listener why, then stops
    /// accepting.
    ///
    /// local-socket.md: "A listener shutting down sends `close` `4000` to every
    /// session first." The ports moved to whoever called
    /// [`IpcListener::accept`], so this writes the farewell through the handle
    /// kept for each of them.
    pub async fn close(self) {
        super::tell_accepted(self.accepted, close_codes::RELEASED, "listener closing").await;
        drop(self.idle);
    }

    fn framed(
        &self,
        reader: ReadHalf<NamedPipeServer>,
        writer: WriteHalf<NamedPipeServer>,
    ) -> IpcServerPort {
        let port = NdjsonPort::new(reader, writer);
        match self.max_frame_bytes {
            Some(limit) => port.with_max_frame_bytes(limit),
            None => port,
        }
    }
}

/// Listens on a named pipe whose access control admits its owner alone.
///
/// local-socket.md records that the reference SDK's pipe "carries no per-user
/// ACL: the socket API the reference SDK builds on cannot attach a security
/// descriptor". That is a limit of Node's socket layer, not of Windows: this
/// crate attaches one, so the address is no more reachable than the POSIX
/// socket file's `0600` makes it. An application still authenticates a peer
/// it has to trust with more than that.
///
/// # Errors
///
/// Whatever creating the first instance of the pipe failed with, including
/// the address already being served by another process.
pub async fn listen_ipc(path: impl AsRef<Path>) -> io::Result<IpcListener> {
    let path = path.as_ref().to_path_buf();
    let idle = security::create_owner_only_instance(&path, true)?;
    Ok(IpcListener {
        idle,
        path,
        max_frame_bytes: None,
        accepted: Vec::new(),
    })
}

/// Connects to a named pipe and returns the port for that connection.
///
/// Every instance being busy is not a refusal: the dialler waits for one to
/// free up, bounded by `deadline` like every other way an attempt can stall.
///
/// # Errors
///
/// [`ConnectError::Io`] with the operating system's own error when the pipe
/// does not exist, and [`ConnectError::TimedOut`]/[`ConnectError::Cancelled`]
/// when `deadline` abandoned the attempt.
pub async fn connect_ipc(
    path: impl AsRef<Path>,
    deadline: &ConnectDeadline,
) -> Result<IpcPort, ConnectError> {
    let path = path.as_ref();
    let target = path.display().to_string();
    let client = connect_within(&target, deadline, async {
        loop {
            match ClientOptions::new().open(path) {
                Ok(client) => return Ok(client),
                Err(error) if error.raw_os_error() == Some(ERROR_PIPE_BUSY) => {
                    tokio::time::sleep(BUSY_RETRY).await;
                }
                Err(error) => return Err(ConnectError::Io(error)),
            }
        }
    })
    .await?;

    let (reader, writer) = tokio::io::split(client);
    Ok(NdjsonPort::new(reader, writer))
}

#[cfg(test)]
mod tests {
    use super::{ConnectDeadline, connect_ipc, listen_ipc};
    use crate::frame::Frame;
    use crate::port::{Inbound, Port, PortRx, PortTx};
    use crate::transports::deadline::ConnectError;
    use std::io;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_ADDRESS: AtomicU64 = AtomicU64::new(0);

    /// A pipe name no other test, and no other run, is using.
    fn address() -> String {
        let unique = NEXT_ADDRESS.fetch_add(1, Ordering::Relaxed);
        format!(r"\\.\pipe\mango-ipc-{}-{unique}", std::process::id())
    }

    #[tokio::test]
    async fn the_owner_can_open_the_pipe_it_created() {
        // The whole point of the descriptor: narrow enough to exclude every
        // other account, wide enough that this one still gets through. A
        // descriptor that admitted nobody would fail exactly here.
        let path = address();
        let mut listener = listen_ipc(&path).await.expect("the address is free");

        let dial = tokio::spawn({
            let path = path.clone();
            async move { connect_ipc(path, &ConnectDeadline::default()).await }
        });
        let (accepted, identity) = listener.accept().await.expect("a client arrives");
        let dialled = dial
            .await
            .expect("the dial task runs")
            .expect("it connects");

        assert_eq!(
            identity.process_id,
            Some(std::process::id()),
            "the pipe names the process that opened it"
        );

        let (mut dialled_tx, _dialled_rx) = dialled.split();
        let (_accepted_tx, mut accepted_rx) = accepted.split();
        dialled_tx.send(Frame::Ping).await;
        assert_eq!(accepted_rx.recv().await, Some(Inbound::Frame(Frame::Ping)));
        listener.close().await;
    }

    #[tokio::test]
    async fn a_second_listener_on_the_same_address_is_refused() {
        let path = address();
        let first = listen_ipc(&path).await.expect("the address is free");

        let error = listen_ipc(&path)
            .await
            .expect_err("the address is already served");

        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        first.close().await;
    }

    #[tokio::test]
    async fn dialling_an_address_with_no_listener_reports_the_system_error() {
        let error = connect_ipc(address(), &ConnectDeadline::default())
            .await
            .expect_err("nothing is listening");
        assert!(
            matches!(error, ConnectError::Io(_)),
            "expected an operating system error, got {error:?}"
        );
    }

    #[tokio::test]
    #[should_panic(expected = "max_frame_bytes is 512; expected at least 4096")]
    async fn with_max_frame_bytes_below_the_floor_panics_naming_both() {
        let listener = listen_ipc(&address()).await.expect("the address is free");
        let _ = listener.with_max_frame_bytes(512);
    }
}
