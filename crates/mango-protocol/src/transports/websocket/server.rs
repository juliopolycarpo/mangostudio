//! Accepting a WebSocket peer: the two things websocket.md puts at the
//! upgrade rather than in a frame — the `mango.v1` subprotocol, and the
//! credential.
//!
//! [`accept_websocket`] is for a peer with no HTTP stack of its own. One that
//! has a server already does the upgrade there and calls
//! [`websocket_port`] with the stream it produced; this
//! crate never depends on an HTTP framework.

use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::http::{HeaderValue, header};
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::{WebSocketStream, accept_hdr_async_with_config};

use crate::close::close_codes;

use super::{WEBSOCKET_SUBPROTOCOL, WebSocketOptions, WebSocketPort, websocket_port};

/// What an acceptor admits, beyond the port settings themselves.
///
/// `allowed_origins` is empty by default, which admits **no browser**: every
/// upgrade carrying an `Origin` is refused with `4403`. That is the right
/// configuration for an acceptor that only ever serves native clients, and the
/// wrong one to leave in place for a hub a page dials — see
/// `spec/transports/websocket.md`, Origin.
///
/// # Example
///
/// ```
/// use mango_protocol::transports::websocket::WebSocketOptions;
/// use mango_protocol::transports::websocket::server::AcceptOptions;
///
/// let options = AcceptOptions::from(WebSocketOptions::default())
///     .with_allowed_origins(["https://app.example"]);
/// assert_eq!(options.allowed_origins, ["https://app.example"]);
/// ```
#[derive(Debug, Clone)]
pub struct AcceptOptions {
    /// How this connection chunks, reassembles and closes.
    pub socket: WebSocketOptions,
    /// Serialised origins a browser may dial from. Empty admits no browser.
    pub allowed_origins: Vec<String>,
    /// Whether an upgrade that never offered `mango.v1` is refused with
    /// `PROTOCOL_ERROR`. `true` by default, matching every native Mango
    /// Protocol dialler, which always offers it — see
    /// [`AcceptOptions::with_subprotocol_optional`] for the one acceptor
    /// that must let an older peer through unlabelled instead.
    subprotocol_required: bool,
}

impl Default for AcceptOptions {
    fn default() -> Self {
        Self {
            socket: WebSocketOptions::default(),
            allowed_origins: Vec::new(),
            subprotocol_required: true,
        }
    }
}

impl From<WebSocketOptions> for AcceptOptions {
    fn from(socket: WebSocketOptions) -> Self {
        Self {
            socket,
            ..Self::default()
        }
    }
}

impl AcceptOptions {
    /// Replaces the origin allow-list.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::transports::websocket::server::AcceptOptions;
    ///
    /// let options = AcceptOptions::default().with_allowed_origins(["https://app.example:8443"]);
    /// assert!(options.allowed_origins.iter().any(|origin| origin.ends_with(":8443")));
    /// ```
    #[must_use]
    pub fn with_allowed_origins<I, S>(mut self, allowed_origins: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.allowed_origins = allowed_origins.into_iter().map(Into::into).collect();
        self
    }

    /// Admits an upgrade that never offered `mango.v1`, rather than closing
    /// it with `PROTOCOL_ERROR` — for an acceptor that must still admit a
    /// peer built before the subprotocol was mandatory (`serve.ts`'s own
    /// documented reasoning: an older hub's socket still gets to answer its
    /// `hello` with a real close code instead of a bare HTTP refusal it has
    /// no vocabulary for). The subprotocol is still echoed back whenever the
    /// peer *does* offer it — this only removes the refusal for one that
    /// offers none.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::transports::websocket::server::AcceptOptions;
    ///
    /// let options = AcceptOptions::default().with_subprotocol_optional();
    /// assert!(!options.requires_subprotocol());
    /// ```
    #[must_use]
    pub fn with_subprotocol_optional(mut self) -> Self {
        self.subprotocol_required = false;
        self
    }

    /// Whether this acceptor refuses an upgrade that never offered
    /// `mango.v1`. See [`AcceptOptions::with_subprotocol_optional`].
    #[must_use]
    pub fn requires_subprotocol(&self) -> bool {
        self.subprotocol_required
    }
}

/// True when `allowed` admits the `Origin` an upgrade carried.
///
/// The comparison is exact on the serialised origin, never a prefix, suffix or
/// substring: `https://app.example.attacker.test` ends with no entry of
/// `["https://app.example"]` and must not be admitted by one. There is no
/// wildcard — an entry is one origin — and an empty list admits no browser.
///
/// An absent `Origin` is not a browser: no user agent attached one, so this
/// check passes it through and the credential is what governs such a dialler.
///
/// # Example
///
/// ```
/// use mango_protocol::transports::websocket::server::is_origin_allowed;
///
/// let allowed = ["https://app.example".to_string()];
/// assert!(is_origin_allowed(Some("https://app.example"), &allowed));
/// assert!(!is_origin_allowed(Some("https://app.example.attacker.test"), &allowed));
/// assert!(is_origin_allowed(None, &[]));
/// ```
#[must_use]
pub fn is_origin_allowed(origin: Option<&str>, allowed: &[String]) -> bool {
    let Some(origin) = origin else {
        return true;
    };
    allowed.iter().any(|entry| entry == origin)
}

/// Why an upgrade did not become a session.
///
/// Every variant but [`AcceptError::Handshake`] happens *after* the upgrade
/// completed, because a refused upgrade reaches the dialler as a socket that
/// failed to open, with no code to read (websocket.md, Authentication).
///
/// # Example
///
/// ```
/// use mango_protocol::transports::websocket::server::AcceptError;
///
/// let refused = AcceptError::Unauthorized { code: 4401 };
/// assert!(refused.to_string().contains("4401"));
/// ```
#[derive(Debug)]
#[non_exhaustive]
pub enum AcceptError {
    /// The upgrade itself failed: not an HTTP request, or the socket went
    /// away mid-handshake.
    Handshake(String),
    /// The dialler never offered `mango.v1`, so it is not a Mango Protocol
    /// session. The socket was closed with `4400`.
    Subprotocol,
    /// The credential was refused. The socket was closed with this code —
    /// `4401` unknown, malformed or revoked, `4403` known but disabled,
    /// `4429` rate limited — and no `hello` was sent.
    Unauthorized {
        /// The close code the dialler can read.
        code: u16,
    },
    /// The upgrade carried an `Origin` the acceptor does not allow-list, so a
    /// page dialled this acceptor from a site it does not serve. The socket
    /// was closed with `4403` and no `hello` was sent.
    Origin {
        /// The origin the upgrade carried, as the browser serialised it.
        origin: String,
    },
}

impl fmt::Display for AcceptError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Handshake(detail) => write!(formatter, "the upgrade failed: {detail}"),
            Self::Subprotocol => write!(
                formatter,
                "the dialler did not offer the {WEBSOCKET_SUBPROTOCOL:?} subprotocol; the socket was closed with {}",
                close_codes::PROTOCOL_ERROR
            ),
            Self::Unauthorized { code } => write!(
                formatter,
                "the credential was refused; the socket was closed with {code} and no hello was sent"
            ),
            Self::Origin { origin } => write!(
                formatter,
                "the upgrade carried origin {origin:?}, which this acceptor does not allow-list; \
                 the socket was closed with {} and no hello was sent",
                close_codes::FORBIDDEN
            ),
        }
    }
}

impl std::error::Error for AcceptError {}

/// Completes the upgrade on `io` and returns the port, having selected the
/// subprotocol, applied the origin allow-list and put the upgrade to
/// `authorize`.
///
/// `authorize` is handed what the upgrade said — the bearer token from
/// `Authorization: Bearer <token>`, the `Origin` — and answers with the close
/// code to refuse it with. It runs **before** any `hello`, which is the
/// guarantee websocket.md asks for: a peer whose credential is no good never
/// sees this side's identity.
///
/// Two checks run before `authorize` ever does. The subprotocol is echoed only
/// when it was offered; a dialler that offered nothing is closed with `4400`
/// rather than left on a socket neither side agrees about, unless
/// [`AcceptOptions::with_subprotocol_optional`] admits it instead. An upgrade
/// carrying an `Origin` outside [`AcceptOptions::allowed_origins`] is closed
/// with `4403`: the default list is empty, so a hub a browser is meant to dial
/// must say which sites it serves.
///
/// # Example
///
/// ```no_run
/// # #[tokio::main(flavor = "current_thread")]
/// # async fn main() -> Result<(), Box<dyn std::error::Error>> {
/// use mango_protocol::close::close_codes;
/// use mango_protocol::frame::PeerInfo;
/// use mango_protocol::session::{Session, SessionOptions};
/// use mango_protocol::transports::websocket::WebSocketOptions;
/// use mango_protocol::transports::websocket::server::accept_websocket;
/// use tokio::net::TcpListener;
///
/// let listener = TcpListener::bind("127.0.0.1:0").await?;
/// let (socket, _address) = listener.accept().await?;
///
/// let port = accept_websocket(socket, WebSocketOptions::default(), |upgrade| {
///     match upgrade.bearer() {
///         Some("s3cret") => Ok(()),
///         _ => Err(close_codes::UNAUTHORIZED),
///     }
/// })
/// .await?;
///
/// let peer = PeerInfo { name: "hub".into(), version: "1".into(), role: "hub".into() };
/// let (_session, _driver) = Session::spawn(port, SessionOptions::new(peer));
/// # Ok(())
/// # }
/// ```
///
/// # Errors
///
/// [`AcceptError`] for an upgrade that failed, a dialler that did not offer
/// the subprotocol, an `Origin` outside the allow-list, or a credential
/// `authorize` refused.
#[allow(
    clippy::result_large_err,
    reason = "the handshake callback's error type is tungstenite's own ErrorResponse"
)]
pub async fn accept_websocket<S, F>(
    io: S,
    options: impl Into<AcceptOptions>,
    authorize: F,
) -> Result<WebSocketPort<S>, AcceptError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    F: FnOnce(&Upgrade) -> Result<(), u16>,
{
    let options = options.into();
    let observed = Arc::new(Mutex::new(Upgrade::default()));
    let recorder = Arc::clone(&observed);
    let stream = accept_hdr_async_with_config(
        io,
        move |request: &Request, mut response: Response| {
            let upgrade = Upgrade::read(request);
            // The subprotocol is echoed only when it was offered: selecting
            // one the dialler never asked for is a handshake it may refuse.
            if upgrade.offered_subprotocol {
                response.headers_mut().insert(
                    header::SEC_WEBSOCKET_PROTOCOL,
                    HeaderValue::from_static(WEBSOCKET_SUBPROTOCOL),
                );
            }
            if let Ok(mut recorder) = recorder.lock() {
                *recorder = upgrade;
            }
            Ok(response)
        },
        Some(options.socket.socket_config()),
    )
    .await
    .map_err(|error| AcceptError::Handshake(error.to_string()))?;

    let upgrade = observed
        .lock()
        .map(|upgrade| upgrade.clone())
        .unwrap_or_default();

    if !upgrade.offered_subprotocol && options.subprotocol_required {
        close_with(
            stream,
            close_codes::PROTOCOL_ERROR,
            "subprotocol not offered",
        )
        .await;
        return Err(AcceptError::Subprotocol);
    }
    if upgrade.origin_undecodable || !is_origin_allowed(upgrade.origin(), &options.allowed_origins)
    {
        let origin = if upgrade.origin_undecodable {
            "<undecodable>".to_string()
        } else {
            upgrade.origin().unwrap_or_default().to_string()
        };
        close_with(stream, close_codes::FORBIDDEN, "origin not allowed").await;
        return Err(AcceptError::Origin { origin });
    }
    if let Err(code) = authorize(&upgrade) {
        close_with(stream, code, "credential refused").await;
        return Err(AcceptError::Unauthorized { code });
    }
    Ok(websocket_port(stream, options.socket))
}

/// What the upgrade request said, read once inside the handshake callback and
/// handed to the `authorize` closure of [`accept_websocket`].
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct Upgrade {
    offered_subprotocol: bool,
    bearer: Option<String>,
    origin: Option<String>,
    /// The upgrade carried an `Origin` header, but its bytes were not valid
    /// UTF-8 — distinct from no header at all: absent is a native dialler,
    /// undecodable is a browser sending something [`Upgrade::origin`] cannot
    /// represent. Refused the same as any origin outside the allow-list,
    /// never treated as "no origin attached".
    origin_undecodable: bool,
}

impl Upgrade {
    /// The token of an `Authorization: Bearer <token>` header, when the
    /// dialler sent one this side can read.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::transports::websocket::server::Upgrade;
    ///
    /// assert_eq!(Upgrade::default().bearer(), None);
    /// ```
    #[must_use]
    pub fn bearer(&self) -> Option<&str> {
        self.bearer.as_deref()
    }

    /// The `Origin` header, serialised as the browser sent it. `None` means
    /// no user agent attached one, which is what a native dialler looks like.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::transports::websocket::server::Upgrade;
    ///
    /// assert_eq!(Upgrade::default().origin(), None);
    /// ```
    #[must_use]
    pub fn origin(&self) -> Option<&str> {
        self.origin.as_deref()
    }

    fn read(request: &Request) -> Self {
        let headers = request.headers();
        let offered_subprotocol = headers
            .get_all(header::SEC_WEBSOCKET_PROTOCOL)
            .iter()
            .filter_map(|value| value.to_str().ok())
            // One header may list several, comma separated (RFC 6455).
            .flat_map(|value| value.split(','))
            .any(|offered| offered.trim() == WEBSOCKET_SUBPROTOCOL);
        let bearer = headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(bearer_token)
            .map(ToOwned::to_owned);
        let origin_header = headers.get(header::ORIGIN);
        let origin = origin_header
            .and_then(|value| value.to_str().ok())
            .map(ToOwned::to_owned);
        let origin_undecodable = origin_header.is_some() && origin.is_none();
        Self {
            offered_subprotocol,
            bearer,
            origin,
            origin_undecodable,
        }
    }
}

/// The token out of an `Authorization` header, when the scheme is `Bearer`.
///
/// # Example
///
/// ```
/// use mango_protocol::transports::websocket::server::bearer_token;
///
/// assert_eq!(bearer_token("Bearer s3cret"), Some("s3cret"));
/// assert_eq!(bearer_token("bearer s3cret"), Some("s3cret"));
/// assert_eq!(bearer_token("Basic abc"), None);
/// ```
#[must_use]
pub fn bearer_token(authorization: &str) -> Option<&str> {
    let (scheme, token) = authorization.split_once(' ')?;
    // RFC 7235 makes the scheme case-insensitive.
    if !scheme.eq_ignore_ascii_case("Bearer") {
        return None;
    }
    let token = token.trim();
    (!token.is_empty()).then_some(token)
}

/// How long a refused socket is given to answer this side's `close` before it
/// is dropped anyway. Bounds the drain after every refusal
/// [`accept_websocket`] sends, so a dialler that never answers holds a refusal
/// up by this much at most.
///
/// Public so an acceptor that refuses a socket after the upgrade, outside
/// [`accept_websocket`], drains it for the same bound.
///
/// # Example
///
/// ```
/// use mango_protocol::transports::websocket::server::REFUSAL_DRAIN_GRACE;
///
/// assert_eq!(REFUSAL_DRAIN_GRACE.as_secs(), 2);
/// ```
pub const REFUSAL_DRAIN_GRACE: Duration = Duration::from_secs(2);

/// Closes a socket the upgrade produced but the session will not use, with a
/// code the dialler can read.
///
/// Then reads the socket until the dialler's own `close` arrives (bounded by
/// [`REFUSAL_DRAIN_GRACE`]) instead of dropping it at once. A dialler usually
/// sends its `hello` the moment the upgrade completes, so by now those bytes
/// are sitting unread; a socket dropped with unread bytes is answered with an
/// RST rather than a FIN, and Windows discards the `close` frame along with
/// it — the dialler reads a bare `4000` instead of the refusal's code.
async fn close_with<S>(mut stream: WebSocketStream<S>, code: u16, reason: &str)
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let frame = CloseFrame {
        code: CloseCode::from(code),
        reason: reason.into(),
    };
    if stream.send(Message::Close(Some(frame))).await.is_err() {
        return;
    }
    let _ = tokio::time::timeout(REFUSAL_DRAIN_GRACE, async {
        while let Some(Ok(message)) = stream.next().await {
            if matches!(message, Message::Close(_)) {
                return;
            }
        }
    })
    .await;
}

#[cfg(test)]
mod tests {
    use super::{AcceptError, Upgrade, bearer_token};
    use crate::transports::websocket::WEBSOCKET_SUBPROTOCOL;
    use tokio_tungstenite::tungstenite::handshake::server::Request;
    use tokio_tungstenite::tungstenite::http::header;

    fn request(headers: &[(&str, &str)]) -> Request {
        let mut builder = Request::builder().uri("/runtime");
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        builder.body(()).expect("a request")
    }

    #[test]
    fn the_subprotocol_is_seen_whether_it_is_alone_or_in_a_list() {
        for offered in [
            WEBSOCKET_SUBPROTOCOL,
            "chat, mango.v1",
            "mango.v1, chat",
            "  mango.v1  ",
        ] {
            let upgrade = Upgrade::read(&request(&[(
                header::SEC_WEBSOCKET_PROTOCOL.as_str(),
                offered,
            )]));
            assert!(upgrade.offered_subprotocol, "{offered:?}");
        }
    }

    #[test]
    fn a_dialler_that_offered_something_else_did_not_offer_this() {
        let upgrade = Upgrade::read(&request(&[(
            header::SEC_WEBSOCKET_PROTOCOL.as_str(),
            "mango.v2",
        )]));
        assert!(!upgrade.offered_subprotocol);
        assert!(!Upgrade::read(&request(&[])).offered_subprotocol);
    }

    #[test]
    fn the_bearer_token_is_read_out_of_the_authorization_header() {
        let upgrade = Upgrade::read(&request(&[(
            header::AUTHORIZATION.as_str(),
            "Bearer s3cret",
        )]));
        assert_eq!(upgrade.bearer.as_deref(), Some("s3cret"));
        assert_eq!(bearer_token("Bearer  padded  "), Some("padded"));
        assert_eq!(bearer_token("Bearer"), None);
        assert_eq!(bearer_token("Bearer "), None);
        assert_eq!(bearer_token("Basic abc"), None);
    }

    #[test]
    fn an_undecodable_origin_is_not_the_same_as_no_origin() {
        use tokio_tungstenite::tungstenite::http::HeaderValue;

        let absent = Upgrade::read(&request(&[]));
        assert_eq!(absent.origin(), None);
        assert!(!absent.origin_undecodable);

        let mut with_undecodable = request(&[]);
        with_undecodable.headers_mut().insert(
            header::ORIGIN,
            HeaderValue::from_bytes(b"\xff\xfe").expect("raw bytes are a valid header value"),
        );
        let undecodable = Upgrade::read(&with_undecodable);
        assert_eq!(undecodable.origin(), None);
        assert!(undecodable.origin_undecodable);
    }

    #[test]
    fn a_refusal_names_the_code_the_dialler_can_read() {
        assert!(
            AcceptError::Unauthorized { code: 4403 }
                .to_string()
                .contains("4403")
        );
        assert!(
            AcceptError::Subprotocol
                .to_string()
                .contains(WEBSOCKET_SUBPROTOCOL)
        );
    }
}
