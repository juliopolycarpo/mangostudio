//! Dialling a WebSocket peer: the `mango.v1` subprotocol offered in the
//! upgrade, the reference `Authorization: Bearer` credential, and `wss://`
//! over rustls with the webpki root set.
//!
//! TLS is client-side only here. The runtime's own `serve` sits behind a
//! TLS-terminating proxy (websocket.md, TLS), so an acceptor takes a stream
//! somebody else already decrypted.

use std::sync::{Arc, OnceLock};

use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{HeaderName, HeaderValue, header};
use tokio_tungstenite::{
    Connector, MaybeTlsStream, WebSocketStream, connect_async_tls_with_config,
};

use crate::transports::deadline::{ConnectDeadline, ConnectError, connect_within};

use super::{WEBSOCKET_SUBPROTOCOL, WebSocketOptions, WebSocketPort, websocket_port};

/// The port a dialled connection produces: a plain socket for `ws://`, a TLS
/// one for `wss://`.
pub type DialledWebSocketPort = WebSocketPort<MaybeTlsStream<TcpStream>>;

/// How a dialler presents itself at the upgrade.
///
/// # Example
///
/// ```
/// use mango_protocol::transports::websocket::client::WebSocketConnectOptions;
///
/// let options = WebSocketConnectOptions::default().with_bearer("s3cret");
/// assert!(options.bearer.is_some());
/// ```
#[derive(Debug, Clone, Default)]
pub struct WebSocketConnectOptions {
    /// The reference credential of websocket.md: sent as
    /// `Authorization: Bearer <token>`. The token never appears inside a
    /// frame.
    pub bearer: Option<String>,
    /// Further upgrade request headers, for an application with a credential
    /// of its own.
    pub headers: Vec<(String, String)>,
    /// How the connection frames once it is up.
    pub websocket: WebSocketOptions,
}

impl WebSocketConnectOptions {
    /// Presents `token` as the bearer credential.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::transports::websocket::client::WebSocketConnectOptions;
    ///
    /// let options = WebSocketConnectOptions::default().with_bearer("s3cret");
    /// assert_eq!(options.bearer.as_deref(), Some("s3cret"));
    /// ```
    #[must_use]
    pub fn with_bearer(mut self, token: impl Into<String>) -> Self {
        self.bearer = Some(token.into());
        self
    }

    /// Adds one upgrade request header.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::transports::websocket::client::WebSocketConnectOptions;
    ///
    /// let options = WebSocketConnectOptions::default().with_header("x-tenant", "acme");
    /// assert_eq!(options.headers.len(), 1);
    /// ```
    #[must_use]
    pub fn with_header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    /// Sets how the connection frames once it is up.
    ///
    /// # Example
    ///
    /// ```
    /// use mango_protocol::transports::websocket::WebSocketOptions;
    /// use mango_protocol::transports::websocket::client::WebSocketConnectOptions;
    ///
    /// let framing = WebSocketOptions::default().with_max_message_bytes(4096);
    /// let options = WebSocketConnectOptions::default().with_websocket(framing);
    /// assert_eq!(options.websocket.max_message_bytes, 4096);
    /// ```
    #[must_use]
    pub fn with_websocket(mut self, websocket: WebSocketOptions) -> Self {
        self.websocket = websocket;
        self
    }
}

/// Dials `url`, offering `mango.v1`, and returns the port once the acceptor
/// has selected that subprotocol.
///
/// An acceptor that completes the upgrade without selecting it has not agreed
/// to speak this protocol, so the connection is closed and the dial refused
/// (websocket.md, Subprotocol).
///
/// # Example
///
/// ```no_run
/// # #[tokio::main(flavor = "current_thread")]
/// # async fn main() {
/// use std::time::Duration;
/// use mango_protocol::frame::PeerInfo;
/// use mango_protocol::session::{Session, SessionOptions};
/// use mango_protocol::transports::deadline::ConnectDeadline;
/// use mango_protocol::transports::websocket::client::{
///     WebSocketConnectOptions, connect_websocket,
/// };
///
/// let options = WebSocketConnectOptions::default().with_bearer("s3cret");
/// let deadline = ConnectDeadline::default().with_timeout(Duration::from_secs(5));
/// let port = connect_websocket("wss://hub.example/runtime", &options, &deadline)
///     .await
///     .expect("the hub accepts the credential");
///
/// let peer = PeerInfo { name: "runtime".into(), version: "1".into(), role: "runtime".into() };
/// let (_session, _driver) = Session::spawn(port, SessionOptions::new(peer));
/// # }
/// ```
///
/// # Errors
///
/// [`ConnectError::Refused`] when the URL, a header or the acceptor's answer
/// is not one this transport can use, [`ConnectError::Io`] when the socket
/// itself failed, and [`ConnectError::TimedOut`]/[`ConnectError::Cancelled`]
/// when `deadline` abandoned the attempt.
pub async fn connect_websocket(
    url: &str,
    options: &WebSocketConnectOptions,
    deadline: &ConnectDeadline,
) -> Result<DialledWebSocketPort, ConnectError> {
    let request = build_request(url, options)?;
    let config = options.websocket.socket_config();
    // Only a `wss://` dial needs one, and only a `wss://` dial should fail
    // when the provider will not build: a plain `ws://` carries no TLS at all,
    // so handing the handshake `None` there is what it already means. The
    // scheme comes from the parsed request rather than the string, which
    // `into_client_request` has already normalised.
    let connector = match request.uri().scheme_str() {
        Some("wss") => Some(tls_connector(url)?),
        _ => None,
    };

    let (stream, response) = connect_within(url, deadline, async move {
        connect_async_tls_with_config(request, Some(config), false, connector)
            .await
            .map_err(|error| handshake_error(url, &error))
    })
    .await?;

    // Belt and braces: the handshake itself refuses an acceptor that selects
    // nothing or selects something that was never offered, so reaching this
    // check with the wrong answer would mean the handshake let one through.
    let selected = response
        .headers()
        .get(header::SEC_WEBSOCKET_PROTOCOL)
        .and_then(|value| value.to_str().ok());
    if selected != Some(WEBSOCKET_SUBPROTOCOL) {
        refuse(stream).await;
        return Err(ConnectError::Refused {
            target: url.to_owned(),
            detail: format!(
                "the acceptor selected subprotocol {selected:?}; expected {WEBSOCKET_SUBPROTOCOL:?}"
            ),
        });
    }
    Ok(websocket_port(stream, options.websocket))
}

/// The upgrade request: the URL, the subprotocol this crate speaks, and
/// whatever credential the caller presents.
fn build_request(
    url: &str,
    options: &WebSocketConnectOptions,
) -> Result<tokio_tungstenite::tungstenite::handshake::client::Request, ConnectError> {
    let mut request = url
        .into_client_request()
        .map_err(|error| ConnectError::Refused {
            target: url.to_owned(),
            detail: format!("{error}; expected a ws:// or wss:// URL"),
        })?;
    let headers = request.headers_mut();
    headers.insert(
        header::SEC_WEBSOCKET_PROTOCOL,
        HeaderValue::from_static(WEBSOCKET_SUBPROTOCOL),
    );
    if let Some(token) = &options.bearer {
        let value = HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| {
            ConnectError::Refused {
                target: url.to_owned(),
                detail: "the bearer token is not a header value; expected visible ASCII".to_owned(),
            }
        })?;
        headers.insert(header::AUTHORIZATION, value);
    }
    for (name, value) in &options.headers {
        let name = HeaderName::from_bytes(name.as_bytes()).map_err(|_| ConnectError::Refused {
            target: url.to_owned(),
            detail: format!("{name:?} is not a header name"),
        })?;
        let value = HeaderValue::from_str(value).map_err(|_| ConnectError::Refused {
            target: url.to_owned(),
            detail: format!("the value of {name:?} is not a header value"),
        })?;
        headers.insert(name, value);
    }
    Ok(request)
}

/// The TLS client configuration `wss://` dials under: the webpki root set and
/// the `ring` provider, built once for the process.
fn tls_connector(target: &str) -> Result<Connector, ConnectError> {
    static CONNECTOR: OnceLock<Result<Connector, String>> = OnceLock::new();
    CONNECTOR
        .get_or_init(build_tls_connector)
        .clone()
        .map_err(|detail| ConnectError::Refused {
            // The URL that was dialled, not the scheme it might have used: a
            // refusal names the target a caller passed in.
            target: target.to_owned(),
            detail,
        })
}

fn build_tls_connector() -> Result<Connector, String> {
    let roots = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    // The provider is named rather than taken from the process default: a
    // library that installed a default would be deciding for the binary it is
    // linked into.
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|error| format!("the TLS provider refused the protocol versions: {error}"))?
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(Connector::Rustls(Arc::new(config)))
}

/// Lets go of a socket the dial will not use. The upgrade completed, so the
/// peer is owed a close rather than a reset.
async fn refuse(mut stream: WebSocketStream<MaybeTlsStream<TcpStream>>) {
    let _ = stream.close(None).await;
}

/// A failed upgrade, as the one error type every dialling transport uses. The
/// operating system's own error is kept as itself so a caller can still read
/// the `ErrorKind` behind a refused address.
fn handshake_error(url: &str, error: &tokio_tungstenite::tungstenite::Error) -> ConnectError {
    match error {
        tokio_tungstenite::tungstenite::Error::Io(io) => {
            ConnectError::Io(std::io::Error::new(io.kind(), io.to_string()))
        }
        other => ConnectError::Refused {
            target: url.to_owned(),
            detail: other.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::{WebSocketConnectOptions, build_request, tls_connector};
    use crate::transports::deadline::ConnectError;
    use crate::transports::websocket::WEBSOCKET_SUBPROTOCOL;
    use tokio_tungstenite::tungstenite::http::header;

    #[test]
    fn the_upgrade_offers_the_subprotocol_and_carries_the_bearer() {
        let options = WebSocketConnectOptions::default()
            .with_bearer("s3cret")
            .with_header("x-tenant", "acme");
        let request = build_request("ws://hub.example/runtime", &options).expect("a ws URL");

        let headers = request.headers();
        assert_eq!(
            headers
                .get(header::SEC_WEBSOCKET_PROTOCOL)
                .and_then(|value| value.to_str().ok()),
            Some(WEBSOCKET_SUBPROTOCOL)
        );
        assert_eq!(
            headers
                .get(header::AUTHORIZATION)
                .and_then(|value| value.to_str().ok()),
            Some("Bearer s3cret")
        );
        assert_eq!(
            headers
                .get("x-tenant")
                .and_then(|value| value.to_str().ok()),
            Some("acme")
        );
    }

    #[test]
    fn an_address_that_is_not_a_url_is_refused_before_anything_opens() {
        // A scheme of `http`/`https` is not refused here: tungstenite reads
        // those as the `ws`/`wss` they stand for. What cannot be read as a URL
        // at all is refused before a socket is opened.
        let error = build_request("hub.example/runtime", &WebSocketConnectOptions::default())
            .expect_err("an address with no scheme is not a URL");
        match error {
            ConnectError::Refused { detail, .. } => {
                assert!(detail.contains("ws:// or wss://"), "{detail}");
            }
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn a_token_that_could_not_be_a_header_value_is_refused() {
        let options = WebSocketConnectOptions::default().with_bearer("line\nbreak");
        let error = build_request("ws://hub.example/runtime", &options)
            .expect_err("a header value cannot hold a newline");
        assert!(error.to_string().contains("visible ASCII"), "{error}");
    }

    #[test]
    fn the_tls_configuration_builds_with_the_ring_provider() {
        // A provider that would not build is a `wss://` dial that fails at
        // run time on exactly the platforms the CI matrix covers.
        tls_connector("wss://hub.example/runtime")
            .expect("the ring provider and the webpki roots agree");
    }
}
