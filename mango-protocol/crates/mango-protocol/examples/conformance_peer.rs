//! A peer that serves the conformance handler set over any transport this
//! crate ships, so another implementation can be driven against it.
//!
//! The TypeScript interop suite runs this binary and talks to it over stdio, a
//! local socket and a WebSocket, in both directions. Nothing here is specific
//! to that suite: it is the smallest complete peer, and it is useful by hand
//! for pointing any Mango Protocol 1 consumer at a Rust runtime that answers.
//!
//! ```text
//! conformance_peer --stdio                       # frames on stdin/stdout
//! conformance_peer --ipc <path>                  # listen on a local socket
//! conformance_peer --ws <addr> [--token <t>]     # listen for WebSocket dials
//! conformance_peer --connect <ws-url|path>       # dial out and serve there
//! ```
//!
//! Every mode but `--stdio` prints `listening <address>` to **stderr** once it
//! is ready, because on stdio the standard output is the wire and one rule is
//! easier to keep than two.

use std::process::ExitCode;
use std::time::Duration;

use mango_protocol::close::close_codes;
use mango_protocol::contract::{Contract, ContractHandlers, ServeOptions};
use mango_protocol::port::Port;
use mango_protocol::session::{Session, SessionClosure, SessionOptions};
use mango_protocol::testing::{conformance_b, conformance_options};
use mango_protocol::transports::deadline::ConnectDeadline;
use mango_protocol::transports::ipc::{connect_ipc, listen_ipc};
use mango_protocol::transports::stdio::stdio_port;
use mango_protocol::transports::websocket::WebSocketOptions;
use mango_protocol::transports::websocket::client::{WebSocketConnectOptions, connect_websocket};
use mango_protocol::transports::websocket::server::accept_websocket;
use tokio::task::JoinHandle;

/// How this peer presents itself. The conformance suite's side `b`, so a
/// driver written against that suite recognises the peer it is talking to.
fn options() -> SessionOptions {
    conformance_options(conformance_b())
}

/// The catalog this peer publishes through `rpc.discover`: the shared example
/// fixture, which the TypeScript interop suite reads from the same file. A
/// driver can therefore compare what came off the wire against the document
/// on disk rather than against a copy of it.
const CATALOG: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../spec/fixtures/1/catalog-example.json"
));

/// Spawns a session over `port` and publishes the catalog on it. The contract
/// declares methods this peer does not implement, which is deliberate: only
/// `rpc.discover` is registered from it, and a call to a declared method
/// still answers `METHOD_UNSUPPORTED` — a catalog is a description, not a
/// promise.
fn serve<P: Port>(port: P) -> JoinHandle<SessionClosure> {
    let (session, driver) = Session::spawn(port, options());
    match publish(&session) {
        Ok(()) => {}
        Err(error) => eprintln!("catalog not published: {error}"),
    }
    driver
}

fn publish(session: &Session) -> Result<(), String> {
    let catalog = serde_json::from_str(CATALOG).map_err(|error| error.to_string())?;
    let contract = Contract::from_catalog(catalog).map_err(|error| error.to_string())?;
    contract
        .serve(session, ContractHandlers::new(), ServeOptions::default())
        .map_err(|error| error.to_string())?
        .persist();
    Ok(())
}

/// How long a dial may take before this peer gives up and says so.
const DIAL_TIMEOUT: Duration = Duration::from_secs(10);

/// What the command line asked for.
enum Mode {
    Stdio,
    Ipc(String),
    WebSocket(String),
    Connect(String),
}

struct Arguments {
    mode: Mode,
    token: Option<String>,
    /// Never read stdin, and never start a session over it, so a launcher's
    /// termination sequence has to escalate past the end of file it starts
    /// with. A child that answered frames would leave on that end of file,
    /// which is the case the other mode already covers.
    ignore_stdin: bool,
}

fn usage() -> &'static str {
    "usage: conformance_peer (--stdio | --ipc <path> | --ws <addr> | --connect <ws-url|path>) \
     [--token <token>] [--ignore-stdin]"
}

fn parse() -> Result<Arguments, String> {
    let mut mode = None;
    let mut token = None;
    let mut ignore_stdin = false;
    let mut argv = std::env::args().skip(1);

    while let Some(argument) = argv.next() {
        let mut value = || {
            argv.next()
                .ok_or_else(|| format!("{argument} needs a value\n{}", usage()))
        };
        match argument.as_str() {
            "--stdio" => mode = Some(Mode::Stdio),
            "--ipc" => mode = Some(Mode::Ipc(value()?)),
            "--ws" => mode = Some(Mode::WebSocket(value()?)),
            "--connect" => mode = Some(Mode::Connect(value()?)),
            "--token" => token = Some(value()?),
            "--ignore-stdin" => ignore_stdin = true,
            other => return Err(format!("unknown argument {other}\n{}", usage())),
        }
    }
    Ok(Arguments {
        mode: mode.ok_or_else(|| format!("no mode given\n{}", usage()))?,
        token,
        ignore_stdin,
    })
}

#[tokio::main]
async fn main() -> ExitCode {
    let arguments = match parse() {
        Ok(arguments) => arguments,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::FAILURE;
        }
    };

    let outcome = match arguments.mode {
        Mode::Stdio => serve_stdio(arguments.ignore_stdin).await,
        Mode::Ipc(path) => serve_ipc(&path).await,
        Mode::WebSocket(address) => serve_websocket(&address, arguments.token.as_deref()).await,
        Mode::Connect(target) => connect(&target, arguments.token.as_deref()).await,
    };
    match outcome {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}

/// One session on this process's own standard streams; ends when the peer
/// closes stdin.
async fn serve_stdio(ignore_stdin: bool) -> Result<(), String> {
    if ignore_stdin {
        // A child that will not take the hint. The launcher's own escalation
        // is what has to end it, which is exactly what this mode is for.
        eprintln!("ignoring stdin");
        std::future::pending::<()>().await;
    }
    let driver = serve(stdio_port());
    let closure = driver.await.map_err(|error| error.to_string())?;
    eprintln!("closed {}", closure.code);
    Ok(())
}

/// A local socket serving one session per accepted connection, for as long as
/// it is left running.
async fn serve_ipc(path: &str) -> Result<(), String> {
    let mut listener = listen_ipc(path)
        .await
        .map_err(|error| format!("cannot listen on {path}: {error}"))?;
    announce(&listener.path().display().to_string());

    loop {
        let (port, identity) = listener
            .accept()
            .await
            .map_err(|error| format!("accept failed: {error}"))?;
        eprintln!("accepted {identity}");
        let driver = serve(port);
        tokio::spawn(driver);
    }
}

/// A WebSocket acceptor serving one session per upgraded connection. When
/// `token` is given it is the only credential admitted; without one, any
/// dialler is served.
async fn serve_websocket(address: &str, token: Option<&str>) -> Result<(), String> {
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .map_err(|error| format!("cannot bind {address}: {error}"))?;
    let bound = listener
        .local_addr()
        .map_err(|error| format!("cannot read the bound address: {error}"))?;
    announce(&bound.to_string());

    loop {
        let (socket, from) = listener
            .accept()
            .await
            .map_err(|error| format!("accept failed: {error}"))?;
        let expected = token.map(ToOwned::to_owned);
        tokio::spawn(async move {
            let accepted =
                accept_websocket(socket, WebSocketOptions::default(), |upgrade| {
                    match (&expected, upgrade.bearer()) {
                        (None, _) => Ok(()),
                        (Some(expected), Some(offered)) if expected == offered => Ok(()),
                        _ => Err(close_codes::UNAUTHORIZED),
                    }
                })
                .await;
            match accepted {
                Ok(port) => {
                    eprintln!("accepted {from}");
                    let driver = serve(port);
                    let _ = driver.await;
                }
                Err(error) => eprintln!("refused {from}: {error}"),
            }
        });
    }
}

/// Dials out and serves one session there: a WebSocket when the target is a
/// URL, a local socket otherwise.
async fn connect(target: &str, token: Option<&str>) -> Result<(), String> {
    let deadline = ConnectDeadline::default().with_timeout(DIAL_TIMEOUT);
    let driver = if target.starts_with("ws://") || target.starts_with("wss://") {
        let mut connect = WebSocketConnectOptions::default();
        if let Some(token) = token {
            connect = connect.with_bearer(token);
        }
        let port = connect_websocket(target, &connect, &deadline)
            .await
            .map_err(|error| format!("cannot dial {target}: {error}"))?;
        announce(target);
        serve(port)
    } else {
        let port = connect_ipc(target, &deadline)
            .await
            .map_err(|error| format!("cannot dial {target}: {error}"))?;
        announce(target);
        serve(port)
    };

    let closure = driver.await.map_err(|error| error.to_string())?;
    eprintln!("closed {}", closure.code);
    Ok(())
}

/// Says where this peer can be reached, on stderr, in the one line a driver
/// waits for. stdout is the wire on stdio and nothing else may use it.
fn announce(address: &str) {
    eprintln!("listening {address}");
}
