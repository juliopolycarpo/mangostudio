//! The POSIX half of the local socket transport: a Unix domain socket the
//! listener publishes owner-only, and the peer credentials the socket itself
//! carries.

use std::io;
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

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
    /// The inode of the socket this listener bound, read while it was still
    /// staged and unreachable, and carried onto `path` by the link or rename
    /// that published it. `close` unlinks only while this is still what sits
    /// at `path`, so a listener that crashed and was replaced does not delete
    /// its replacement's file.
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
    /// [`crate::codec::ndjson::MIN_MAX_FRAME_BYTES`], naming both.
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
        let identity = identity_of(&stream);
        let port = self.port(stream);
        // Connections that have since ended are forgotten here rather than
        // accumulating for the life of a long-running listener.
        self.accepted.retain(PortCloser::is_open);
        self.accepted.push(port.closer());
        Ok((port, identity))
    }

    /// Tells every session still open on this listener why, stops accepting,
    /// and removes the socket file — but only while it is still this
    /// listener's own. A listener that crashed and was replaced, then closed
    /// late on a handle nobody dropped, must not delete the replacement's
    /// address; the inode recorded when this listener published is what
    /// tells the two apart, since both sit at the same `path`.
    ///
    /// local-socket.md: "A listener shutting down sends `close` `4000` to every
    /// session first." The ports moved to whoever called
    /// [`IpcListener::accept`], so this writes the farewell through the handle
    /// kept for each of them; a peer then reads an announced release rather
    /// than inferring one from a socket that vanished.
    pub async fn close(self) {
        super::tell_accepted(self.accepted, close_codes::RELEASED, "listener closing").await;
        drop(self.listener);
        // Best effort, and only this listener's to report on: an address
        // already gone is nothing to remove, and one a newer listener
        // replaced after this one stopped is that listener's file now, not
        // this one's.
        let Ok(metadata) = tokio::fs::symlink_metadata(&self.path).await else {
            return;
        };
        if metadata.ino() == self.inode {
            let _ = tokio::fs::remove_file(&self.path).await;
        }
    }

    fn port(&self, stream: UnixStream) -> IpcServerPort {
        socket_port(stream, self.max_frame_bytes)
    }
}

/// Listens on a local socket, owner-only from the instant the address exists.
///
/// The socket is bound inside an owner-only directory beside `path`,
/// restricted to `0600` there, and then published at `path`. `bind` takes its
/// mode from the umask, so binding straight onto the address would publish a
/// world-connectable socket for as long as a `chmod` takes; the TypeScript SDK
/// closes that window by setting the process-wide umask, which a library
/// cannot do without reaching into every other thread. Staging inside a
/// directory nobody else may enter closes it without leaving this call.
///
/// A socket file at the address is *stale* — and removed first — when a
/// connection to it is refused; binding refuses instead when a connection
/// succeeds or cannot be judged, because the address counts as in use
/// (local-socket.md, Addresses). Anything at the address that is not a socket
/// is refused rather than replaced or judged: a regular file there is a
/// mistake the caller has to see.
///
/// # Errors
///
/// Whatever binding, restricting or publishing the address failed with;
/// [`io::ErrorKind::AlreadyExists`] when something that is not a socket
/// already holds the address, or when another listener took it while this one
/// was binding; and [`io::ErrorKind::AddrInUse`] when a live listener answers
/// at the address already.
pub async fn listen_ipc(path: impl AsRef<Path>) -> io::Result<IpcListener> {
    let path = path.as_ref().to_path_buf();
    remove_stale_socket(&path).await?;

    let staging = staging_path(&path);
    let staged = stage_and_publish(&staging, &path).await;
    discard(&staging).await;
    let (listener, inode) = staged?;

    Ok(IpcListener {
        listener,
        path,
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
fn staging_path(path: &Path) -> Staging {
    static NEXT_ATTEMPT: AtomicU64 = AtomicU64::new(0);
    let attempt = NEXT_ATTEMPT.fetch_add(1, Ordering::Relaxed);
    let beside = path.parent().unwrap_or_else(|| Path::new("."));
    let directory = beside.join(format!(".m{}-{attempt}", std::process::id()));
    let socket = directory.join("s");
    Staging { directory, socket }
}

/// The two paths one staging attempt owns.
#[derive(Debug)]
struct Staging {
    directory: PathBuf,
    socket: PathBuf,
}

/// Binds inside a fresh owner-only directory, restricts the socket, and links
/// it onto the address. Whatever this fails at, [`discard`] cleans up after.
///
/// The inode comes back with the listener, read from the staged socket while
/// it is still inside a directory nobody else may enter — and so while
/// nothing can be racing it. Both of [`publish`]'s moves keep the inode the
/// `bind` created, so it is the number that sits at `path` afterwards.
/// Reading it from `path` *after* publishing would record a replacement's
/// inode whenever another listener took the address in between, which is the
/// one case [`IpcListener::close`]'s guard exists to survive; it would also
/// leave a bound, published address behind if that read were the call to
/// fail.
async fn stage_and_publish(staging: &Staging, path: &Path) -> io::Result<(UnixListener, u64)> {
    let listener = stage(staging).await?;
    let inode = tokio::fs::symlink_metadata(&staging.socket).await?.ino();
    publish(&staging.socket, path).await?;
    Ok((listener, inode))
}

/// Binds the socket somewhere no other user may reach it.
async fn stage(staging: &Staging) -> io::Result<UnixListener> {
    // A crash between staging and publishing leaves the directory behind, and
    // a later process with the same id reaches the same name. Removing it is
    // never recursive: this only ever clears what a staging attempt of ours
    // would have left, and a directory somebody else planted at the name is
    // reported rather than deleted.
    discard(staging).await;
    tokio::fs::DirBuilder::new()
        .mode(STAGING_DIRECTORY_MODE)
        .create(&staging.directory)
        .await?;
    let listener = UnixListener::bind(&staging.socket)?;
    restrict(&staging.socket).await?;
    Ok(listener)
}

/// Removes what a staging attempt leaves behind, best effort: the socket is
/// gone already when publishing renamed rather than linked, and the directory
/// only goes when it is this attempt's and empty.
///
/// Nothing is removed unless a directory in its own right sits at the staging
/// name. The name is derived from this process's id, and the directory an
/// address usually sits in can be the world-writable system temporary one, so
/// a symlink somebody else planted there first would otherwise turn this
/// cleanup into an unlink inside a directory of their choosing. Anything that
/// is not a directory is left where it is and reported by the `create` that
/// follows.
async fn discard(staging: &Staging) {
    if !is_directory(&staging.directory).await {
        return;
    }
    let _ = tokio::fs::remove_file(&staging.socket).await;
    let _ = tokio::fs::remove_dir(&staging.directory).await;
}

/// True when a directory — never a symlink to one — sits at `path`.
async fn is_directory(path: &Path) -> bool {
    matches!(
        tokio::fs::symlink_metadata(path).await,
        Ok(metadata) if metadata.file_type().is_dir()
    )
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
/// A filesystem that will not hard-link a socket falls back to the rename,
/// which is still atomic and still owner-only — it only loses the refusal.
async fn publish(staging: &Path, path: &Path) -> io::Result<()> {
    match tokio::fs::hard_link(staging, path).await {
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
        Err(_) => tokio::fs::rename(staging, path).await,
    }
}

/// Makes the socket file readable and writable by its owner alone.
async fn restrict(path: &Path) -> io::Result<()> {
    tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(SOCKET_MODE)).await
}

/// Removes the socket file a previous process left behind. Only a socket is
/// removed: anything else at the address is a mistake to report, not
/// something to delete.
async fn remove_stale_socket(path: &Path) -> io::Result<()> {
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
    match probe(path).await {
        Staleness::Stale => remove_if_still(path, metadata.ino()).await,
        Staleness::Live => Err(io::Error::new(
            io::ErrorKind::AddrInUse,
            format!(
                "{} is served by a live listener; expected the address to be free or a socket \
                 file nothing answers on",
                path.display()
            ),
        )),
    }
}

/// Unlinks `path`, but only while it is still the same file the probe judged
/// stale. `probe` waits up to a second, and a second supervisor racing the
/// same restart against the same address is exactly who can remove and
/// rebind it inside that window — unlinking on the stale verdict alone would
/// then delete the winner's live socket file out from under it. Silently
/// doing nothing when the inode has moved on is correct: [`publish`]'s own
/// `AlreadyExists` guard is what tells *this* caller the address was taken,
/// the same outcome a plain, unguarded race would have produced for the
/// loser anyway. This narrows the window from the whole probe to the gap
/// between this check and the unlink; it does not close it — there is no
/// unlink-by-inode primitive on this platform to close it with.
async fn remove_if_still(path: &Path, inode: u64) -> io::Result<()> {
    let Ok(metadata) = tokio::fs::symlink_metadata(path).await else {
        return Ok(());
    };
    if metadata.ino() == inode {
        tokio::fs::remove_file(path).await?;
    }
    Ok(())
}

/// Whether a socket file at an address is stale, or a live listener still
/// answers behind it — local-socket.md's definition: "a socket file at the
/// address is stale when a connection to it is refused".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Staleness {
    Stale,
    Live,
}

/// Dials `path` to tell a stale socket file from one a live listener answers
/// on. [`io::ErrorKind::ConnectionRefused`] and [`io::ErrorKind::NotFound`]
/// are stale: the listener that made the file is gone, whether the socket
/// still refuses connections or the file was removed under the dial.
/// Everything else — a successful connect, the timeout, a permission error —
/// is live. Erring toward live is deliberate: taking over an address this
/// could not judge is exactly the failure [`remove_stale_socket`] exists to
/// refuse, so an inconclusive dial must never read as stale.
async fn probe(path: &Path) -> Staleness {
    match tokio::time::timeout(PROBE_TIMEOUT, UnixStream::connect(path)).await {
        Ok(Ok(stream)) => {
            // A live listener answered; nothing more to do with the
            // connection than let the dial itself have proven the point.
            drop(stream);
            Staleness::Live
        }
        Ok(Err(error))
            if matches!(
                error.kind(),
                io::ErrorKind::ConnectionRefused | io::ErrorKind::NotFound
            ) =>
        {
            Staleness::Stale
        }
        Ok(Err(_)) | Err(_) => Staleness::Live,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ConnectDeadline, IpcListener, SOCKET_MODE, STAGING_DIRECTORY_MODE, UnixListener,
        connect_ipc, discard, listen_ipc, publish, remove_if_still, stage, staging_path,
    };
    use crate::close::close_codes;
    use crate::frame::Frame;
    use crate::port::{Inbound, Port, PortRx, PortTx};
    use crate::transports::deadline::ConnectError;
    use std::io;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
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
        let deadline = tokio::time::Instant::now() + CONCURRENT_FORKING_WAIT;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            match tokio::time::timeout(remaining, listen_ipc(path)).await {
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
        let listener = stage(&staging).await.expect("a staged socket");

        let containing = staging
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
        discard(&staging).await;
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

        let error = stage(&staging)
            .await
            .expect_err("a name this attempt did not create is not its to clear");

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
    async fn closing_a_listener_takes_its_address_with_it() {
        let address = Address::new();
        let listener = listening(&address).await;
        assert!(address.path().exists());

        listener.close().await;

        assert!(
            !address.path().exists(),
            "a closed listener leaves no address behind"
        );
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

        let error = publish(&staging, &taken)
            .await
            .expect_err("the address is no longer free");

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
    async fn a_stale_socket_file_is_replaced() {
        let address = Address::new();
        // A listener that vanished without closing leaves its address behind.
        drop(listening(&address).await);

        let second = listen_ipc_past_a_concurrent_forking_test(&address.path())
            .await
            .expect("a stale socket is not an occupied address");
        second.close().await;
    }

    #[tokio::test(start_paused = true)]
    async fn stale_socket_retries_outlast_a_temporarily_live_listener() {
        let address = Address::new();
        let held = listening(&address).await;
        let release = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            drop(held);
        });

        let replacement = listen_ipc_past_a_concurrent_forking_test(&address.path())
            .await
            .expect("the retry outlasts the transient inherited listener");

        release.await.expect("the listener release task finishes");
        replacement.close().await;
    }

    #[tokio::test(start_paused = true)]
    async fn stale_socket_retry_leaves_a_listener_that_remains_live_occupied() {
        let address = Address::new();
        let listener = listening(&address).await;

        let path = address.path();
        let error = tokio::select! {
            result = listen_ipc_past_a_concurrent_forking_test(&path) => {
                result.expect_err("a listener that remains live is still occupied")
            }
            // Drain probes so this checks a live listener, independently of
            // the platform's listen backlog capacity.
            () = async {
                loop {
                    let _ = listener.listener.accept().await.expect("the live listener accepts probes");
                }
            } => unreachable!("the probe drain continues until the retry settles"),
        };

        assert_eq!(error.kind(), io::ErrorKind::AddrInUse);
        listener.close().await;
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
    async fn a_replacement_at_the_same_path_survives_a_stale_removal_judged_before_it_arrived() {
        let address = Address::new();
        // Keeps A's inode number out of B's reach once A's file is unlinked;
        // see `closing_leaves_a_replacement_address_alone` for why the bare
        // `assert_ne!` below is not self-sufficient.
        let pin = Address::new();
        let stale_inode = {
            let a = listening(&address).await;
            let inode = a.inode;
            std::fs::hard_link(address.path(), pin.path()).expect("A's inode to be pinned");
            drop(a);
            inode
        };

        // The window `remove_stale_socket`'s probe leaves open: another
        // supervisor already removed and rebound the address by the time the
        // stale verdict this call is acting on is applied.
        let b = listen_ipc_past_a_concurrent_forking_test(&address.path())
            .await
            .expect("a stale socket is not an occupied address");
        assert_ne!(
            stale_inode, b.inode,
            "B must be a different socket for this test to mean anything"
        );

        remove_if_still(&address.path(), stale_inode)
            .await
            .expect("a path B still occupies is not an error to leave alone");

        let survived =
            std::fs::symlink_metadata(address.path()).expect("B's socket file must still be there");
        assert_eq!(
            survived.ino(),
            b.inode,
            "expected B's socket file untouched, received a different inode at its path"
        );
        connect_ipc(address.path(), &ConnectDeadline::default())
            .await
            .expect("B still accepts a connection");

        b.close().await;
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

        let b = listen_ipc_past_a_concurrent_forking_test(&address.path())
            .await
            .expect("a stale socket is not an occupied address");
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
