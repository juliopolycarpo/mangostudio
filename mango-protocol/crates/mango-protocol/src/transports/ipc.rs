//! The local socket transport of `spec/transports/local-socket.md`: a Unix
//! domain socket on POSIX, a named pipe on Windows, NDJSON framed exactly as
//! stdio is.
//!
//! One accepted connection is one session; a listener serves many at once.
//! [`IpcListener::accept`] hands out a [`Port`](crate::port::Port) together
//! with whatever identity the operating system offered for the peer that
//! opened it, so an application that needs more than same-machine trust can
//! refuse a connection with `close` `4401` before serving anything.
//!
//! # Example
//!
//! ```no_run
//! # #[tokio::main(flavor = "current_thread")]
//! # async fn main() -> std::io::Result<()> {
//! use mango_protocol::frame::PeerInfo;
//! use mango_protocol::session::{Session, SessionOptions};
//! use mango_protocol::transports::ipc::{ipc_path, listen_ipc};
//!
//! let path = ipc_path("mango-hub").expect("a single path segment");
//! let mut listener = listen_ipc(&path).await?;
//! let (port, peer_identity) = listener.accept().await?;
//! println!("accepted a connection from {peer_identity}");
//!
//! let peer = PeerInfo { name: "hub".into(), version: "1.0.0".into(), role: "hub".into() };
//! let (_session, _driver) = Session::spawn(port, SessionOptions::new(peer));
//! # Ok(())
//! # }
//! ```

use std::fmt;
use std::path::PathBuf;

use tokio::io::AsyncWrite;
use tokio::task::JoinSet;

use crate::transports::ndjson::PortCloser;

#[cfg(unix)]
mod unix;
#[cfg(unix)]
use unix as platform;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as platform;

pub use platform::{IpcListener, IpcPort, IpcServerPort, connect_ipc, listen_ipc};

/// A name that could not become a local socket address.
///
/// # Example
///
/// ```
/// use mango_protocol::transports::ipc::ipc_path;
///
/// let refused = ipc_path("../escape").expect_err("a name that could escape its directory");
/// assert!(refused.to_string().contains("expected one non-empty path segment"));
/// ```
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IpcNameError {
    name: String,
}

impl fmt::Display for IpcNameError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "ipc name is {:?}; expected one non-empty path segment without \"/\", \"\\\" or \"..\"",
            self.name
        )
    }
}

impl std::error::Error for IpcNameError {}

/// The identity the operating system offers for the peer on the other end of
/// an accepted connection.
///
/// POSIX gives the peer's credentials through the socket itself; Windows
/// gives the client process. Neither is an application credential: a peer
/// that has to prove more than "the same machine, this user" carries it in
/// `hello.capabilities` (local-socket.md, Authentication).
///
/// # Example
///
/// ```
/// use mango_protocol::transports::ipc::PeerIdentity;
///
/// let unknown = PeerIdentity::default();
/// assert_eq!(unknown.to_string(), "a peer the operating system did not identify");
/// ```
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct PeerIdentity {
    /// The peer's process, when the platform offers one.
    pub process_id: Option<u32>,
    /// The peer's POSIX user and group; `None` on Windows.
    pub user: Option<PeerUser>,
}

/// The POSIX credentials behind a [`PeerIdentity`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PeerUser {
    /// Effective user id of the process that connected.
    pub uid: u32,
    /// Effective group id of the process that connected.
    pub gid: u32,
}

impl fmt::Display for PeerIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match (self.user, self.process_id) {
            (Some(user), Some(pid)) => {
                write!(
                    formatter,
                    "uid {} gid {} in process {pid}",
                    user.uid, user.gid
                )
            }
            (Some(user), None) => write!(formatter, "uid {} gid {}", user.uid, user.gid),
            (None, Some(pid)) => write!(formatter, "process {pid}"),
            (None, None) => formatter.write_str("a peer the operating system did not identify"),
        }
    }
}

/// The reference address for a named local endpoint: a Windows named pipe, or
/// a socket file in the user's runtime directory (`$XDG_RUNTIME_DIR`, else the
/// system temporary directory).
///
/// # Example
///
/// ```
/// use mango_protocol::transports::ipc::ipc_path;
///
/// let path = ipc_path("mango-hub").expect("one path segment");
/// assert!(path.to_string_lossy().contains("mango-hub"));
/// ```
///
/// # Errors
///
/// [`IpcNameError`] for a name that could escape its directory or spell a
/// different pipe: an empty one, or one containing `/`, `\` or `..`.
pub fn ipc_path(name: &str) -> Result<PathBuf, IpcNameError> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(IpcNameError {
            name: name.to_owned(),
        });
    }
    Ok(platform::address_for(name))
}

/// Tells every session a listener accepted why it is going, all at once.
///
/// One at a time would stack each port's close-flush grace, so a single peer
/// that stopped reading would hold the listener — and the address it is about
/// to release — open for the sake of every other session's farewell.
async fn tell_accepted<W>(accepted: Vec<PortCloser<W>>, code: u16, reason: &'static str)
where
    W: AsyncWrite + Unpin + Send + 'static,
{
    let mut farewells = JoinSet::new();
    for port in accepted {
        farewells.spawn(async move { port.close(code, Some(reason)).await });
    }
    farewells.join_all().await;
}

#[cfg(test)]
mod tests {
    use super::{PeerIdentity, PeerUser, ipc_path};

    #[test]
    fn a_name_becomes_an_address_carrying_it() {
        let path = ipc_path("mango-hub").expect("one path segment");
        assert!(
            path.to_string_lossy().contains("mango-hub"),
            "{}",
            path.display()
        );
    }

    #[test]
    fn a_name_that_could_escape_its_directory_is_refused() {
        for name in ["", "a/b", "a\\b", "..", "a..b"] {
            let error = ipc_path(name).expect_err("a name that is not one segment");
            assert!(
                error
                    .to_string()
                    .contains("expected one non-empty path segment"),
                "{name:?}: {error}"
            );
        }
    }

    #[test]
    fn an_identity_says_what_the_platform_offered() {
        let both = PeerIdentity {
            process_id: Some(42),
            user: Some(PeerUser {
                uid: 1000,
                gid: 100,
            }),
        };
        assert_eq!(both.to_string(), "uid 1000 gid 100 in process 42");
        let windows = PeerIdentity {
            process_id: Some(42),
            user: None,
        };
        assert_eq!(windows.to_string(), "process 42");
    }
}
