//! The POSIX half of the local socket transport: a Unix domain socket the
//! listener publishes owner-only, and the peer credentials the socket itself
//! carries.

use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use std::{fs, io};

use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::{UnixListener, UnixStream};

use crate::close::close_codes;
use crate::transports::deadline::{ConnectDeadline, ConnectError, connect_within};
use crate::transports::ndjson::{NdjsonPort, PortCloser};

use super::{PeerIdentity, PeerUser};

/// Owner-only, the permission local-socket.md requires of a POSIX socket file.
const SOCKET_MODE: u32 = 0o600;

/// Owner-only and not searchable by anyone else, which is what keeps a socket
/// staged inside it out of reach before its own mode is set.
const STAGING_DIRECTORY_MODE: u32 = 0o700;
const MAX_STAGING_ATTEMPTS: usize = 16;

/// How long [`probe`] waits for a verdict before erring toward "live" — the
/// same 1 second the TypeScript SDK's `clearStaleSocket` uses.
const PROBE_TIMEOUT: Duration = Duration::from_secs(1);

/// The port a dialled connection produces.
pub type IpcPort = NdjsonPort<OwnedReadHalf, OwnedWriteHalf>;

/// The port an accepted connection produces. The same type on POSIX, where
/// both ends of a Unix socket are the same kind of object.
pub type IpcServerPort = IpcPort;

/// A socket file in the user's runtime directory.
pub(super) fn address_for(name: &str) -> PathBuf {
    let directory = std::env::var_os("XDG_RUNTIME_DIR")
        .filter(|value| !value.is_empty())
        .map_or_else(std::env::temp_dir, PathBuf::from);
    directory.join(format!("{name}.sock"))
}

/// A listener on a local socket, and the address it actually bound.
///
/// # Example
///
/// ```no_run
/// # #[tokio::main(flavor = "current_thread")]
/// # async fn main() -> std::io::Result<()> {
/// use mango_protocol::transports::ipc::listen_ipc;
///
/// let mut listener = listen_ipc("/run/user/1000/mango-hub.sock").await?;
/// let (_port, _identity) = listener.accept().await?;
/// listener.close().await;
/// # Ok(())
/// # }
/// ```
#[derive(Debug)]
pub struct IpcListener {
    listener: UnixListener,
    path: PathBuf,
    /// Historical identity retained for diagnostics/tests only; never cleanup authority.
    #[cfg(test)]
    inode: u64,
    max_frame_bytes: Option<usize>,
    /// Weak handles to the ports handed out, so shutting down can tell the
    /// sessions still using them. Holding one never keeps a connection alive.
    accepted: Vec<PortCloser<OwnedWriteHalf>>,
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
    /// let listener = listen_ipc("/run/user/1000/mango-hub.sock").await?;
    /// assert!(listener.path().ends_with("mango-hub.sock"));
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
    /// [`crate::codec::ndjson::MIN_MAX_FRAME_BYTES`] or above
    /// [`crate::validate::MAX_ANNOUNCED_FRAME_BYTES`], naming the violated bound.
    ///
    /// # Example
    ///
    /// ```no_run
    /// # #[tokio::main(flavor = "current_thread")]
    /// # async fn main() -> std::io::Result<()> {
    /// use mango_protocol::transports::ipc::listen_ipc;
    ///
    /// let listener = listen_ipc("/run/user/1000/mango-hub.sock")
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

    /// Waits for the next connection and hands back its port and the identity
    /// the socket carries.
    ///
    /// # Errors
    ///
    /// Whatever `accept` failed with. Reading the peer's credentials is not
    /// one of those: a platform that will not answer leaves the identity
    /// empty rather than refusing a connection that is otherwise fine.
    pub async fn accept(&mut self) -> io::Result<(IpcServerPort, PeerIdentity)> {
        let (stream, _address) = self.listener.accept().await?;
        self.accepted.retain(PortCloser::is_open);
        if self.accepted.len() >= super::MAX_IPC_CONNECTIONS {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "local socket connection capacity 64 is full",
            ));
        }
        let identity = identity_of(&stream);
        let port = self.port(stream);
        // Connections that have since ended are forgotten here rather than
        // accumulating for the life of a long-running listener.
        self.accepted.retain(PortCloser::is_open);
        self.accepted.push(port.closer());
        Ok((port, identity))
    }

    /// Sends release to owned sessions and stops accepting. The public socket path
    /// is deliberately preserved: stat/unlink cannot prove atomic ownership, and
    /// inode reuse or a final-window rebind must never authorize successor removal.
    /// The returned disposition makes externally coordinated cleanup explicit.
    pub async fn close(self) -> super::IpcCloseOutcome {
        super::tell_accepted(self.accepted, close_codes::RELEASED, "listener closing").await;
        drop(self.listener);
        // No portable atomic conditional-unlink exists. Inode equality is not ownership.
        super::IpcCloseOutcome::PathPreserved(self.path)
    }

    fn port(&self, stream: UnixStream) -> IpcServerPort {
        socket_port(stream, self.max_frame_bytes)
            .with_first_hello_timeout(super::FIRST_HELLO_TIMEOUT)
    }
}

/// Listens on a local socket, owner-only from the instant the address exists.
///
/// The socket is bound inside an owner-only directory on the same device as `path`,
/// restricted to `0600` there, and then published at `path`. `bind` takes its
/// mode from the umask, so binding straight onto the address would publish a
/// world-connectable socket for as long as a `chmod` takes; the TypeScript SDK
/// closes that window by setting the process-wide umask, which a library
/// cannot do without reaching into every other thread. Staging inside a
/// directory nobody else may enter closes it without leaving this call.
///
/// Existing socket paths are always preserved. A dial result is an observation,
/// never authority for a later unlink. Refused, connected and inconclusive outcomes
/// carry distinct diagnostics with the compatible `AddrInUse` error kind.
///
/// # Errors
///
/// `InvalidInput` for an invalid native socket pathname, before staging;
/// binding, restricting or no-replace publication errors; `AlreadyExists` for a
/// non-socket or competing publisher; `AddrInUse` for an existing socket path.
/// Filesystems that cannot hard-link sockets fail closed rather than rename over
/// a possibly live endpoint. Externally coordinate old-path cleanup before reuse.
pub async fn listen_ipc(path: impl AsRef<Path>) -> io::Result<IpcListener> {
    let path = path.as_ref().to_path_buf();
    // A short staged bind must not hide an undialable public pathname.
    std::os::unix::net::SocketAddr::from_pathname(&path)?;
    refuse_occupied_socket(&path).await?;

    // Creation, publication and handing the listener to the caller share one
    // poll. Cancellation must not leave a public socket without its listener.
    let (listener, inode) = stage_and_publish(&path)?;
    let _ = inode;

    Ok(IpcListener {
        listener,
        path,
        #[cfg(test)]
        inode,
        max_frame_bytes: None,
        accepted: Vec::new(),
    })
}

/// Connects to a local socket and returns the port for that connection.
///
/// # Errors
///
/// [`ConnectError::Io`] with the operating system's own error when the path
/// has no listener, and [`ConnectError::TimedOut`]/[`ConnectError::Cancelled`]
/// when `deadline` abandoned an attempt nobody completed.
pub async fn connect_ipc(
    path: impl AsRef<Path>,
    deadline: &ConnectDeadline,
) -> Result<IpcPort, ConnectError> {
    let path = path.as_ref();
    let target = path.display().to_string();
    let stream = connect_within(&target, deadline, async {
        Ok(UnixStream::connect(path).await?)
    })
    .await?;
    Ok(socket_port(stream, None))
}

/// One connection, one port: the socket is both the byte source and the sink.
fn socket_port(stream: UnixStream, max_frame_bytes: Option<usize>) -> IpcPort {
    let (reader, writer) = stream.into_split();
    let port = NdjsonPort::new(reader, writer);
    match max_frame_bytes {
        Some(limit) => port.with_max_frame_bytes(limit),
        None => port,
    }
}

/// The credentials the socket carries for the peer that opened it.
fn identity_of(stream: &UnixStream) -> PeerIdentity {
    let Ok(credentials) = stream.peer_cred() else {
        return PeerIdentity::default();
    };
    PeerIdentity {
        process_id: credentials.pid().and_then(|pid| u32::try_from(pid).ok()),
        user: Some(PeerUser {
            uid: credentials.uid(),
            gid: credentials.gid(),
        }),
    }
}

/// Where a listener binds before it publishes: a directory of its own beside
/// the address, so the link onto the address stays within one filesystem, and
/// unique per attempt, so two listeners racing for the same address do not
/// stage over each other.
///
/// A directory rather than a bare name, because the name is not a secret. It
/// is derived from this process's id, and the directory an address usually
/// sits in — the fallback system temporary directory — is searchable by every
/// local user. `bind` takes the socket's mode from the umask, so between it
/// and [`restrict`] the only thing that can refuse a stranger is the
/// directory the socket sits in.
///
/// Short names, because these are the paths `bind` actually sees and
/// `sun_path` is 104 bytes on macOS. An address close to that limit would
/// otherwise fail to bind at a staging name longer than itself.
fn staging_path(path: &Path) -> StagingPath {
    static NEXT_ATTEMPT: AtomicU64 = AtomicU64::new(0);
    let attempt = NEXT_ATTEMPT.fetch_add(1, Ordering::Relaxed);
    let beside = path.parent().unwrap_or_else(|| Path::new("."));
    let directory = beside.join(format!(".m{}-{attempt}", std::process::id()));
    let socket = directory.join("s");
    StagingPath { directory, socket }
}

/// Candidate paths carry no authority until the directory is created.
#[derive(Debug)]
struct StagingPath {
    directory: PathBuf,
    socket: PathBuf,
}

/// Owns a directory created exclusively for this attempt.
#[derive(Debug)]
struct Staging(StagingPath);

impl Drop for Staging {
    fn drop(&mut self) {
        let StagingPath { directory, socket } = &self.0;
        if fs::symlink_metadata(directory).is_ok_and(|metadata| metadata.is_dir()) {
            let _ = fs::remove_file(socket);
            let _ = fs::remove_dir(directory);
        }
    }
}

/// Finds short private staging on the destination device, then publishes without replacement.
/// A valid public path may have too little room left in its parent for our private suffix.
/// Try same-device ancestors; a mount boundary never justifies replacing rename.
fn stage_and_publish(path: &Path) -> io::Result<(UnixListener, u64)> {
    let parent = path
        .parent()
        .filter(|value| !value.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let device = fs::metadata(parent)?.dev();
    let mut last_failure: Option<io::Error> = None;
    for ancestor in parent.ancestors() {
        if ancestor.as_os_str().is_empty() && parent == Path::new(".") {
            continue;
        }
        let ancestor = if ancestor.as_os_str().is_empty() {
            Path::new(".")
        } else {
            ancestor
        };
        if fs::metadata(ancestor)?.dev() != device {
            continue;
        }
        for _ in 0..MAX_STAGING_ATTEMPTS {
            let staging = staging_path(&ancestor.join("endpoint"));
            if std::os::unix::net::SocketAddr::from_pathname(&staging.socket).is_err() {
                break;
            }
            match stage(staging) {
                Ok((listener, staging)) => {
                    // The staged identity is diagnostic/test data, never unlink authority.
                    let inode = fs::symlink_metadata(&staging.0.socket)?.ino();
                    publish(&staging.0.socket, path)?;
                    return Ok((listener, inode));
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    last_failure = Some(error);
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::PermissionDenied | io::ErrorKind::ReadOnlyFilesystem
                    ) =>
                {
                    last_failure = Some(error);
                    break;
                }
                Err(error) => return Err(error),
            }
        }
    }
    let kind = last_failure
        .as_ref()
        .map_or(io::ErrorKind::Unsupported, io::Error::kind);
    Err(io::Error::new(
        kind,
        format!(
            "{} could not be published: expected private same-device staging within the native socket pathname limit; public path preserved; last staging failure: {last_failure:?}",
            path.display()
        ),
    ))
}

/// Acquires a fresh private directory before binding or acquiring cleanup rights.
fn stage(path: StagingPath) -> io::Result<(UnixListener, Staging)> {
    fs::DirBuilder::new()
        .mode(STAGING_DIRECTORY_MODE)
        .create(&path.directory)?;
    let staging = Staging(path);
    let listener = UnixListener::bind(&staging.0.socket)?;
    restrict(&staging.0.socket)?;
    Ok((listener, staging))
}

/// Moves the bound socket onto the address it is published at.
///
/// A hard link, not a rename, because it is the one of the two that refuses
/// rather than replaces: a second listener that bound the same address while
/// this one was setting up gets [`io::ErrorKind::AlreadyExists`], which is the
/// `EADDRINUSE` a plain `bind` onto the address would have produced. A rename
/// would silently take the address over and leave that listener bound to an
/// inode no client can reach.
///
/// A filesystem that cannot hard-link sockets is unsupported; never fall back
/// to a replacing rename.
fn publish(staging: &Path, path: &Path) -> io::Result<()> {
    match fs::hard_link(staging, path) {
        // The link is the address now; the staging name is the caller's to
        // clear, along with the directory holding it.
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!(
                "{} was taken by another listener while this one was binding; \
                 expected the address to be free",
                path.display()
            ),
        )),
        Err(error) => Err(io::Error::new(
            error.kind(),
            format!(
                "{} could not be published without replacement; path preserved: {error}",
                path.display()
            ),
        )),
    }
}

/// Makes the socket file readable and writable by its owner alone.
fn restrict(path: &Path) -> io::Result<()> {
    fs::set_permissions(path, fs::Permissions::from_mode(SOCKET_MODE))
}

/// Observes an occupied address and preserves it without conditional-unlink authority.
async fn refuse_occupied_socket(path: &Path) -> io::Result<()> {
    let metadata = match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) => metadata,
        // Nothing at the path, which is the ordinary case.
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if !metadata.file_type().is_socket() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!(
                "{} is {:?}; expected nothing, or a socket file a previous listener left behind",
                path.display(),
                metadata.file_type()
            ),
        ));
    }
    let verdict = probe(path).await;
    Err(probe_refusal(path, &verdict))
}

fn probe_refusal(path: &Path, verdict: &ProbeVerdict) -> io::Error {
    io::Error::new(
        io::ErrorKind::AddrInUse,
        format!(
            "{}: probe {}; path preserved because atomic cleanup ownership is unproven; expected a free address or externally coordinated cleanup",
            path.display(),
            verdict.description()
        ),
    )
}

#[derive(Debug, PartialEq, Eq)]
enum ProbeVerdict {
    Connected,
    Refused(String),
    Inconclusive(String),
}

impl ProbeVerdict {
    fn description(&self) -> String {
        match self {
            Self::Connected => "connected (connection established)".into(),
            Self::Refused(reason) => format!("refused ({reason})"),
            Self::Inconclusive(reason) => format!("inconclusive ({reason})"),
        }
    }
}

fn probe_error(error: &io::Error) -> ProbeVerdict {
    if matches!(
        error.kind(),
        io::ErrorKind::ConnectionRefused | io::ErrorKind::NotFound
    ) {
        ProbeVerdict::Refused(error.to_string())
    } else {
        ProbeVerdict::Inconclusive(error.to_string())
    }
}

/// A positive dial enqueues a connection, but sends no hello or application frame.
async fn probe(path: &Path) -> ProbeVerdict {
    match tokio::time::timeout(PROBE_TIMEOUT, UnixStream::connect(path)).await {
        Ok(Ok(stream)) => {
            drop(stream);
            ProbeVerdict::Connected
        }
        Ok(Err(error)) => probe_error(&error),
        Err(_) => ProbeVerdict::Inconclusive("timeout".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ConnectDeadline, IpcListener, SOCKET_MODE, STAGING_DIRECTORY_MODE, UnixListener,
        connect_ipc, listen_ipc, publish, stage, staging_path,
    };
    use crate::close::close_codes;
    use crate::frame::Frame;
    use crate::port::{Inbound, Port, PortRx, PortTx};
    use crate::transports::deadline::ConnectError;
    use std::io;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Duration;
    use tokio_util::sync::CancellationToken;

    static NEXT_ADDRESS: AtomicU64 = AtomicU64::new(0);
    const CONCURRENT_FORKING_RETRY: Duration = Duration::from_millis(10);
    const CONCURRENT_FORKING_WAIT: Duration = Duration::from_secs(2);

    /// A socket path in a directory that goes away with the test. The crate
    /// carries no development dependency for one, and this is the only module
    /// that needs a scratch directory.
    struct Address(PathBuf);

    impl Address {
        fn new() -> Self {
            let unique = NEXT_ADDRESS.fetch_add(1, Ordering::Relaxed);
            let directory =
                std::env::temp_dir().join(format!("mango-ipc-{}-{unique}", std::process::id()));
            std::fs::create_dir_all(&directory).expect("a scratch directory");
            Self(directory)
        }

        fn path(&self) -> PathBuf {
            self.0.join("mango.sock")
        }
    }

    impl Drop for Address {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    async fn listening(address: &Address) -> IpcListener {
        listen_ipc(address.path())
            .await
            .expect("the address is free")
    }

    /// `listen_ipc`, retried briefly on `AddrInUse`, for a test that stages a
    /// dead listener and expects the next one to see it as stale.
    ///
    /// This test binary runs every test in one process, and an unrelated
    /// test's `Command::spawn` can fork a child at the exact instant this
    /// test's own listener socket is still open on this thread — `fork`
    /// duplicates every file descriptor regardless of `CLOEXEC`, which only
    /// takes effect at the child's own `execve`. In that microseconds-wide
    /// gap the forked child holds its own copy of the fd, which is enough to
    /// make a probe launched in that instant see the address as live. A
    /// bounded series of retries outlasts the gap without changing what the assertion
    /// means: the address is stale once the fork elsewhere has moved on,
    /// which every one of these retries still requires. The deadline is
    /// absolute because one [`listen_ipc`] call can itself spend
    /// [`PROBE_TIMEOUT`] judging a socket. Concrete errors other than
    /// [`io::ErrorKind::AddrInUse`] return unchanged; a probe that reaches
    /// the deadline reports [`io::ErrorKind::TimedOut`].
    async fn listen_ipc_past_a_concurrent_forking_test(path: &Path) -> io::Result<IpcListener> {
        retry_inherited_listener(path, || listen_ipc(path)).await
    }

    async fn retry_inherited_listener<T, F, Fut>(path: &Path, mut listen: F) -> io::Result<T>
    where
        F: FnMut() -> Fut,
        Fut: std::future::Future<Output = io::Result<T>>,
    {
        let deadline = tokio::time::Instant::now() + CONCURRENT_FORKING_WAIT;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            match tokio::time::timeout(remaining, listen()).await {
                Ok(Err(error)) if error.kind() == io::ErrorKind::AddrInUse => {
                    if deadline.saturating_duration_since(tokio::time::Instant::now())
                        <= CONCURRENT_FORKING_RETRY
                    {
                        return Err(error);
                    }
                    tokio::time::sleep(CONCURRENT_FORKING_RETRY).await;
                }
                Ok(outcome) => return outcome,
                Err(_) => {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        format!("{path:?} did not settle within {CONCURRENT_FORKING_WAIT:?}"),
                    ));
                }
            }
        }
    }

    #[tokio::test]
    async fn the_published_socket_is_owner_only() {
        let address = Address::new();
        let listener = listening(&address).await;

        let mode = std::fs::metadata(listener.path())
            .expect("the socket exists")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, SOCKET_MODE, "expected {SOCKET_MODE:o}, got {mode:o}");
        listener.close().await;
    }

    #[tokio::test]
    #[should_panic(expected = "max_frame_bytes is 512; expected at least 4096")]
    async fn with_max_frame_bytes_below_the_floor_panics_naming_both() {
        let address = Address::new();
        let listener = listening(&address).await;
        let _ = listener.with_max_frame_bytes(512);
    }

    #[tokio::test]
    async fn nothing_is_left_beside_the_published_address() {
        let address = Address::new();
        let listener = listening(&address).await;

        // Every name in the directory, rather than a recomputed staging path:
        // the counter moves on every call, so asking `staging_path` again
        // would check a name this listener never used, and the assertion would
        // hold however much was left behind.
        let left: Vec<_> = std::fs::read_dir(&address.0)
            .expect("the scratch directory is readable")
            .map(|entry| entry.expect("an entry").file_name())
            .collect();
        assert_eq!(
            left,
            vec![std::ffi::OsString::from("mango.sock")],
            "the socket is published and the staging name is gone"
        );
        listener.close().await;
    }

    #[test]
    fn a_staging_name_is_short_enough_to_bind_beside_a_long_address() {
        // `sun_path` is 104 bytes on macOS, so the name this binds at must not
        // grow with the address it will be published under.
        let long = format!("/tmp/{}.sock", "a".repeat(80));
        let staging = staging_path(Path::new(&long));
        assert!(
            staging.socket.as_os_str().len() < long.len(),
            "{} is not shorter than {long}",
            staging.socket.display()
        );
        assert_eq!(staging.directory.parent(), Path::new(&long).parent());
    }

    #[tokio::test]
    async fn a_staged_socket_sits_where_no_other_user_may_reach_it() {
        // `bind` takes its mode from the umask, so between it and the `chmod`
        // the socket is whatever the umask allows — usually world-connectable.
        // Nothing about the name protects it: it is this process's id, in a
        // directory every local user may search. The directory it is staged
        // inside is what refuses them.
        let address = Address::new();
        let staging = staging_path(&address.path());
        let (listener, staging) = stage(staging).expect("a staged socket");

        let containing = staging
            .0
            .socket
            .parent()
            .expect("the socket is staged inside a directory of its own");
        let mode = std::fs::metadata(containing)
            .expect("the staging directory exists while the socket does")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(
            mode,
            STAGING_DIRECTORY_MODE,
            "expected {STAGING_DIRECTORY_MODE:o} on {}, got {mode:o}",
            containing.display()
        );

        drop(listener);
        drop(staging);
    }

    #[tokio::test]
    async fn a_preexisting_staging_directory_keeps_its_contents() {
        let address = Address::new();
        let staging = staging_path(&address.path());
        std::fs::create_dir(&staging.directory).expect("another owner's staging directory");
        std::fs::write(&staging.socket, b"other owner's file").expect("a file named s");

        let existing_socket = staging.socket.clone();
        let result = stage(staging);
        assert_eq!(
            std::fs::read(existing_socket).ok().as_deref(),
            Some(b"other owner's file".as_slice()),
            "a colliding staging attempt must preserve the existing s file"
        );
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::AlreadyExists);
    }

    fn check_cancellation_at_filesystem_visibility(published: bool) {
        use std::future::Future;
        use std::task::{Context, Poll, Waker};

        let runtime = tokio::runtime::Builder::new_current_thread()
            .max_blocking_threads(1)
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let address = Address::new();
            let path = address.path();
            let listener = {
                let mut pending = std::pin::pin!(listen_ipc(&path));
                let mut context = Context::from_waker(Waker::noop());
                let mut result = None;
                for _ in 0..32 {
                    if let Poll::Ready(ready) = pending.as_mut().poll(&mut context) {
                        result = Some(ready.expect("a free address must be bindable"));
                        break;
                    }
                    // A single blocking thread makes this a barrier after the
                    // filesystem operation queued by the preceding poll.
                    tokio::task::spawn_blocking(|| {}).await.unwrap();
                    let visible = if published {
                        path.exists()
                    } else {
                        std::fs::read_dir(&address.0).unwrap().next().is_some()
                    };
                    if visible {
                        break;
                    }
                }
                result
            };

            if let Some(listener) = listener {
                assert!(
                    path.exists(),
                    "a returned listener must own a published address"
                );
                assert_eq!(std::fs::read_dir(&address.0).unwrap().count(), 1);
                listener.close().await;
            } else {
                assert_eq!(
                    std::fs::read_dir(&address.0).unwrap().count(),
                    0,
                    "cancelling an unfinished listen left a filesystem entry"
                );
                listen_ipc(&path)
                    .await
                    .expect("a cancelled bind must leave the address reusable")
                    .close()
                    .await;
            }
        });
    }

    #[test]
    fn cancelling_listen_cannot_leak_a_private_staging_entry() {
        check_cancellation_at_filesystem_visibility(false);
    }

    #[test]
    fn cancelling_listen_cannot_leave_an_ownerless_public_address() {
        check_cancellation_at_filesystem_visibility(true);
    }

    #[tokio::test]
    async fn a_symlink_planted_at_the_staging_name_is_not_followed() {
        // The staging name is this process's id, and the directory an address
        // falls back to is one every local user may write to. Clearing what a
        // crashed attempt of ours left behind must not follow a name somebody
        // else got there first with: that would unlink a file inside a
        // directory of their choosing, as this process's user.
        let address = Address::new();
        let elsewhere = address.0.join("elsewhere");
        std::fs::create_dir(&elsewhere).expect("a directory somebody else owns");
        let bait = elsewhere.join("s");
        std::fs::write(&bait, b"not this listener's file").expect("a file behind the symlink");

        let staging = staging_path(&address.path());
        std::os::unix::fs::symlink(&elsewhere, &staging.directory).expect("the planted symlink");

        let error =
            stage(staging).expect_err("a name this attempt did not create is not its to clear");

        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert!(
            bait.exists(),
            "{} was unlinked through the planted symlink",
            bait.display()
        );
    }

    #[tokio::test]
    async fn an_accepted_connection_carries_frames_and_names_its_peer() {
        let address = Address::new();
        let mut listener = listening(&address).await;

        let dial = tokio::spawn({
            let path = address.path();
            async move { connect_ipc(path, &ConnectDeadline::default()).await }
        });
        let (accepted, identity) = listener.accept().await.expect("a connection arrives");
        let dialled = dial
            .await
            .expect("the dial task runs")
            .expect("it connects");

        // The test dials itself, so the peer the socket reports is this very
        // process — the check an application makes before it serves anything.
        assert!(
            identity.user.is_some(),
            "a POSIX socket carries the peer's credentials"
        );
        if let Some(pid) = identity.process_id {
            assert_eq!(pid, std::process::id());
        }

        let (mut dialled_tx, _dialled_rx) = dialled.split();
        let (_accepted_tx, mut accepted_rx) = accepted.split();
        dialled_tx.send(Frame::Ping).await;
        assert_eq!(accepted_rx.recv().await, Some(Inbound::Frame(Frame::Ping)));
        listener.close().await;
    }

    #[tokio::test]
    async fn closing_a_listener_tells_the_sessions_it_accepted() {
        let address = Address::new();
        let mut listener = listening(&address).await;
        let dial = tokio::spawn({
            let path = address.path();
            async move { connect_ipc(path, &ConnectDeadline::default()).await }
        });
        let (_accepted, _identity) = listener.accept().await.expect("a connection arrives");
        let dialled = dial
            .await
            .expect("the dial task runs")
            .expect("it connects");
        let (_dialled_tx, mut dialled_rx) = dialled.split();

        listener.close().await;

        // An announced release, not one inferred from a socket that vanished.
        assert_eq!(
            dialled_rx.recv().await,
            Some(Inbound::Frame(Frame::Close(crate::frame::Close {
                code: close_codes::RELEASED,
                reason: Some("listener closing".into()),
            })))
        );
    }

    #[tokio::test]
    async fn closing_a_listener_explicitly_preserves_its_public_path() {
        let address = Address::new();
        let listener = listening(&address).await;
        assert!(address.path().exists());

        let outcome = listener.close().await;
        assert_eq!(
            outcome,
            super::super::IpcCloseOutcome::PathPreserved(address.path())
        );
        assert!(address.path().exists());
    }

    #[tokio::test]
    async fn publishing_onto_an_address_that_appeared_meanwhile_is_refused() {
        // The window this closes is between the stale-socket check and the
        // publish, which no test can open on purpose; what can be checked is
        // that the step itself refuses rather than replaces. A rename would
        // have taken the address over and left its listener on an inode no
        // client can reach.
        let address = Address::new();
        let staging = address.0.join("staging.sock");
        let taken = address.path();
        std::fs::write(&staging, b"the socket this listener bound").expect("a staging file");
        std::fs::write(&taken, b"what another listener published").expect("an occupied address");

        let error = publish(&staging, &taken).expect_err("the address is no longer free");

        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert!(
            error.to_string().contains("while this one was binding"),
            "{error}"
        );
        assert_eq!(
            std::fs::read(&taken).expect("the address is untouched"),
            b"what another listener published"
        );
    }

    #[tokio::test]
    async fn a_stale_socket_file_is_preserved_without_atomic_ownership() {
        let address = Address::new();
        // A listener that vanished without closing leaves its address behind.
        drop(listening(&address).await);

        let error = listen_ipc(address.path())
            .await
            .expect_err("stale is not cleanup authority");
        assert_eq!(error.kind(), io::ErrorKind::AddrInUse);
        assert!(error.to_string().contains("path preserved"));
        assert!(address.path().exists());
    }

    struct HeldListenerProbe {
        release_at: tokio::time::Instant,
    }

    impl HeldListenerProbe {
        fn listen(&self) -> std::future::Ready<io::Result<()>> {
            let result = if tokio::time::Instant::now() >= self.release_at {
                Ok(())
            } else {
                Err(io::Error::new(io::ErrorKind::AddrInUse, "listener is held"))
            };
            std::future::ready(result)
        }
    }

    struct UnresponsiveListenerProbe;

    impl UnresponsiveListenerProbe {
        fn listen() -> std::future::Pending<io::Result<()>> {
            std::future::pending()
        }
    }

    #[tokio::test(start_paused = true)]
    async fn stale_socket_retries_outlast_a_temporarily_live_listener() {
        let probe = HeldListenerProbe {
            release_at: tokio::time::Instant::now() + Duration::from_millis(150),
        };
        retry_inherited_listener(Path::new("held-listener.sock"), || probe.listen())
            .await
            .expect("the retry outlasts the transient inherited listener");
    }

    #[tokio::test(start_paused = true)]
    async fn stale_socket_retry_leaves_a_listener_that_remains_live_occupied() {
        let start = tokio::time::Instant::now();
        let probe = HeldListenerProbe {
            release_at: start + CONCURRENT_FORKING_WAIT * 2,
        };
        let error = retry_inherited_listener(Path::new("held-listener.sock"), || probe.listen())
            .await
            .expect_err("a listener that remains live is still occupied");

        assert_eq!(error.kind(), io::ErrorKind::AddrInUse);
        assert!(tokio::time::Instant::now() - start <= CONCURRENT_FORKING_WAIT);
    }

    #[tokio::test(start_paused = true)]
    async fn stale_socket_retry_bounds_an_attempt_that_never_settles() {
        let start = tokio::time::Instant::now();
        let error = retry_inherited_listener(
            Path::new("pending-listener.sock"),
            UnresponsiveListenerProbe::listen,
        )
        .await
        .expect_err("an unresponsive probe cannot exceed the overall deadline");

        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(error.to_string().contains("pending-listener.sock"));
        assert_eq!(tokio::time::Instant::now() - start, CONCURRENT_FORKING_WAIT);
    }

    #[tokio::test]
    async fn stale_socket_retry_preserves_non_addr_in_use_errors() {
        let address = Address::new();
        std::fs::write(address.path(), b"not a socket").expect("the regular file is written");

        let expected = listen_ipc(address.path())
            .await
            .expect_err("a regular file is not a socket");
        let actual = listen_ipc_past_a_concurrent_forking_test(&address.path())
            .await
            .expect_err("the retry returns the regular-file error");

        assert_eq!(actual.kind(), expected.kind());
        assert_eq!(actual.to_string(), expected.to_string());
    }

    #[tokio::test]
    async fn a_live_listener_is_not_stale() {
        let address = Address::new();
        let mut first = listening(&address).await;

        let error = listen_ipc(address.path())
            .await
            .expect_err("a live listener answers; the address is not stale");
        assert_eq!(
            error.kind(),
            io::ErrorKind::AddrInUse,
            "expected AddrInUse, received a listener"
        );

        let dial = tokio::spawn({
            let path = address.path();
            async move {
                let dialled = connect_ipc(path, &ConnectDeadline::default())
                    .await
                    .expect("the first listener still answers");
                let (mut tx, _rx) = dialled.split();
                tx.send(Frame::Ping).await;
            }
        });

        // The refused `listen_ipc` call above already dialled and dropped a
        // probe connection of its own, which may sit ahead of the real
        // client in this listener's accept queue. That connection closes
        // without ever delivering a frame — `Inbound::Closed` rather than the
        // `Ping` the real client sends — so it is not what this test waits
        // for.
        // Bounded, because the skipping is what makes this loop able to wait
        // forever: if the real client's `Ping` never arrives, the probe's own
        // connection is the only thing the queue ever holds, and an unbounded
        // `accept()` would hang the test binary instead of saying what was
        // expected.
        let delivered = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let (accepted, _identity) =
                    first.accept().await.expect("the listener keeps answering");
                let (_tx, mut rx) = accepted.split();
                if let Some(frame @ Inbound::Frame(Frame::Ping)) = rx.recv().await {
                    break frame;
                }
            }
        })
        .await
        .expect("expected Inbound::Frame(Ping) from the real client, received nothing in 10s");
        assert_eq!(delivered, Inbound::Frame(Frame::Ping));

        dial.await.expect("the dial task runs");
        first.close().await;
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn a_long_parent_does_not_make_private_staging_exceed_the_native_limit() {
        let address = Address::new();
        let limit = if cfg!(target_os = "linux") { 107 } else { 103 };
        let parent = address
            .0
            .join("p".repeat(limit - address.0.as_os_str().len() - 3));
        std::fs::create_dir(&parent).unwrap();
        let path = parent.join("s");
        assert_eq!(path.as_os_str().len(), limit);
        drop(
            std::os::unix::net::UnixListener::bind(&path)
                .expect("the exact long-parent public path binds natively"),
        );
        std::fs::remove_file(&path).expect("exclusive fixture cleanup");
        let listener = listen_ipc(&path)
            .await
            .expect("private staging must fit when the public path is valid");
        assert_eq!(
            std::fs::read_dir(&address.0).unwrap().count(),
            1,
            "ancestor staging must be removed before returning the listener"
        );
        assert_eq!(
            std::fs::read_dir(&parent).unwrap().count(),
            1,
            "the public parent must contain only its socket"
        );
        let connected = connect_ipc(&path, &ConnectDeadline::default())
            .await
            .expect("the published public address dials");
        drop(connected);
        listener.close().await;
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn public_path_at_native_socket_limit_is_dialable() {
        let address = Address::new();
        let limit = if cfg!(target_os = "linux") { 107 } else { 103 };
        let path = address
            .0
            .join("x".repeat(limit - address.0.as_os_str().len() - 1));
        assert_eq!(path.as_os_str().len(), limit);
        drop(
            std::os::unix::net::UnixListener::bind(&path)
                .expect("the exact public boundary is natively bindable"),
        );
        std::fs::remove_file(&path)
            .expect("the exclusive fixture owns the dropped native listener");
        let listener = listen_ipc(&path)
            .await
            .expect("valid public boundary must remain available");
        let connected = connect_ipc(&path, &ConnectDeadline::default())
            .await
            .expect("the published boundary must be dialable");
        drop(connected);
        listener.close().await;
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn public_path_above_native_socket_limit_is_not_published() {
        let address = Address::new();
        let limit = if cfg!(target_os = "linux") { 107 } else { 103 };
        let path = address
            .0
            .join("x".repeat(limit - address.0.as_os_str().len()));
        assert_eq!(path.as_os_str().len(), limit + 1);
        match listen_ipc(&path).await {
            Ok(listener) => {
                let dial_error = tokio::net::UnixStream::connect(&path)
                    .await
                    .expect_err("native dial must reject this oversized address");
                listener.close().await;
                panic!("listen_ipc published an undialable public pathname: {dial_error}");
            }
            Err(error) => assert_eq!(error.kind(), io::ErrorKind::InvalidInput),
        }
        assert!(
            !path.exists(),
            "rejection must not publish an unreachable endpoint"
        );
    }

    #[tokio::test]
    async fn probe_eof_never_dispatches_an_application_handler() {
        use crate::frame::PeerInfo;
        use crate::session::{CallContext, Session, SessionOptions};
        use std::sync::Arc;
        use std::sync::atomic::AtomicUsize;
        let address = Address::new();
        let mut listener = listening(&address).await;
        let error = listen_ipc(address.path()).await.unwrap_err();
        assert!(error.to_string().contains("probe connected"));
        let (port, _identity) = listener.accept().await.unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let handler_calls = Arc::clone(&calls);
        let options = SessionOptions::new(PeerInfo {
            name: "probe-fixture".into(),
            version: "0".into(),
            role: "hub".into(),
        })
        .handle(
            "expensive",
            move |_params: serde_json::Value, _context: CallContext| {
                handler_calls.fetch_add(1, Ordering::SeqCst);
                async { Ok(serde_json::Value::Null) }
            },
        );
        let (session, driver) = Session::spawn(port, options);
        assert!(
            tokio::time::timeout(Duration::from_secs(1), session.ready())
                .await
                .unwrap()
                .is_err()
        );
        tokio::time::timeout(Duration::from_secs(1), driver)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        listener.close().await;
    }

    #[test]
    fn shared_probe_fixture_distinguishes_refusal_from_uncertainty() {
        let fixtures: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../spec/fixtures/local-socket-probes.json"
        ))
        .unwrap();
        for fixture in fixtures.as_array().unwrap() {
            let kind = match fixture["error"].as_str().unwrap() {
                "ECONNREFUSED" => io::ErrorKind::ConnectionRefused,
                "ENOENT" => io::ErrorKind::NotFound,
                "EACCES" => io::ErrorKind::PermissionDenied,
                "EAGAIN" => io::ErrorKind::WouldBlock,
                "ETIMEDOUT" => io::ErrorKind::TimedOut,
                other => panic!("unknown fixture {other}"),
            };
            let verdict = super::probe_error(&io::Error::from(kind));
            let expected = fixture["outcome"].as_str().unwrap();
            assert!(verdict.description().starts_with(expected));
            let diagnostic = super::probe_refusal(Path::new("fixture.sock"), &verdict);
            assert_eq!(diagnostic.kind(), io::ErrorKind::AddrInUse);
            assert!(!diagnostic.to_string().contains("live listener"));
            assert!(diagnostic.to_string().contains("path preserved"));
        }
        assert!(
            super::ProbeVerdict::Connected
                .description()
                .starts_with("connected")
        );
    }

    #[tokio::test]
    async fn accepted_port_reservations_are_bounded_and_released_with_their_owner() {
        let address = Address::new();
        let mut listener = listening(&address).await;
        let mut ports = Vec::new();
        let mut clients = Vec::new();
        for _ in 0..super::super::MAX_IPC_CONNECTIONS {
            clients.push(
                connect_ipc(address.path(), &ConnectDeadline::default())
                    .await
                    .unwrap(),
            );
            ports.push(listener.accept().await.unwrap().0);
        }
        let extra = connect_ipc(address.path(), &ConnectDeadline::default())
            .await
            .unwrap();
        assert_eq!(
            listener.accept().await.unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
        drop(ports);
        let next = connect_ipc(address.path(), &ConnectDeadline::default())
            .await
            .unwrap();
        let (accepted, _) = listener
            .accept()
            .await
            .expect("dropped owners release reservations");
        drop((accepted, next, extra, clients));
        listener.close().await;
    }

    #[tokio::test]
    async fn recycled_inode_identity_is_not_cleanup_authority() {
        let address = Address::new();
        let successor = listening(&address).await;
        let scratch = Address::new();
        let late = IpcListener {
            listener: UnixListener::bind(scratch.path()).unwrap(),
            path: address.path(),
            // Deterministically model inode reuse without depending on the filesystem allocator.
            inode: successor.inode,
            max_frame_bytes: None,
            accepted: Vec::new(),
        };
        late.close().await;
        assert!(
            address.path().exists(),
            "a recycled identity cannot authorize unlinking the successor"
        );
        successor.close().await;
    }

    #[tokio::test]
    async fn closing_leaves_a_replacement_address_alone() {
        let address = Address::new();
        // A's inode has to stay distinct from B's for the rest of this test to
        // mean anything, and unlinking A's socket frees its inode number for
        // B's `bind` to be handed straight back — CI has done exactly that. A
        // hard link elsewhere keeps A's link count above zero past the unlink,
        // so the number cannot be reused while this test still needs it. The
        // link lives under its own `Address` so nothing extra sits in the
        // directory `listen_ipc` stages beside.
        let pin = Address::new();
        let a_inode = {
            let a = listening(&address).await;
            let inode = a.inode;
            std::fs::hard_link(address.path(), pin.path()).expect("A's inode to be pinned");
            // A crash: the file descriptor closes without the unlink `close`
            // performs, leaving a stale file behind — the same shape
            // `a_stale_socket_file_is_replaced` relies on.
            drop(a);
            inode
        };

        std::fs::remove_file(address.path())
            .expect("fixture owns all listeners and coordinates replacement");
        let b = listen_ipc(address.path())
            .await
            .expect("explicitly freed address");
        assert_ne!(
            a_inode, b.inode,
            "B must be a different socket for this test to mean anything"
        );

        // A's own handle, as it looked right before the crash: what a caller
        // holding a stale `IpcListener` and calling `close()` late on it is.
        // The `listener` field itself is irrelevant to what `close` decides —
        // only `path` and `inode` are — so a throwaway socket fills it.
        let scratch = Address::new();
        let throwaway = UnixListener::bind(scratch.path()).expect("a throwaway socket to bind");
        let late = IpcListener {
            listener: throwaway,
            path: address.path(),
            inode: a_inode,
            max_frame_bytes: None,
            accepted: Vec::new(),
        };
        late.close().await;

        assert!(
            address.path().exists(),
            "expected B's address to survive A's close, received NotFound"
        );
        connect_ipc(address.path(), &ConnectDeadline::default())
            .await
            .expect("B still accepts a connection");

        b.close().await;
    }

    #[tokio::test]
    async fn a_regular_file_at_the_address_is_reported_not_replaced() {
        let address = Address::new();
        std::fs::write(address.path(), b"not a socket").expect("the file is written");

        let error = listen_ipc(address.path())
            .await
            .expect_err("a regular file is not a stale socket");

        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert!(
            error.to_string().contains("expected nothing, or a socket"),
            "{error}"
        );
        assert!(
            Path::new(&address.path()).exists(),
            "the caller's own file is still there"
        );
    }

    #[tokio::test]
    async fn dialling_an_address_with_no_listener_reports_the_system_error() {
        let address = Address::new();
        let error = connect_ipc(address.path(), &ConnectDeadline::default())
            .await
            .expect_err("nothing is listening");

        match error {
            ConnectError::Io(error) => assert_eq!(error.kind(), io::ErrorKind::NotFound),
            other => panic!("expected an operating system error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_dial_the_caller_already_gave_up_on_opens_nothing() {
        let address = Address::new();
        let listener = listening(&address).await;
        let token = CancellationToken::new();
        token.cancel();

        let error = connect_ipc(
            address.path(),
            &ConnectDeadline::default().with_cancel(token),
        )
        .await
        .expect_err("a cancelled dial is abandoned");

        assert!(matches!(error, ConnectError::Cancelled { .. }));
        listener.close().await;
    }
}
