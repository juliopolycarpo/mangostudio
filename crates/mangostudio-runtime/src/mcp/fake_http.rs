//! `FakeHttpMcpServer`: a named fake MCP server over real loopback HTTP for transport tests.
//!
//! Deliberately tiny: one request per connection (`Connection: close`), just enough JSON-RPC to
//! answer `initialize`, `tools/list`, and notifications, and a record of every request's method,
//! path, and headers so tests can assert what crossed the runtime → server boundary.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

/// How the fake answers.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Mode {
    /// Streamable HTTP: JSON responses to POST, 405 to GET.
    Streamable,
    /// Legacy HTTP+SSE only: the base URL's POST answers `post_status`, its GET opens the stream.
    LegacySse {
        post_status: u16,
        cross_origin: bool,
    },
    /// Every POST answers this status; nothing else is served.
    Status(u16),
}

/// One request as the server saw it.
#[derive(Clone, Debug)]
pub(crate) struct Recorded {
    pub method: String,
    pub path: String,
    pub headers: BTreeMap<String, String>,
}

pub(crate) struct FakeHttpMcpServer {
    pub url: String,
    pub requests: Arc<Mutex<Vec<Recorded>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for FakeHttpMcpServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl FakeHttpMcpServer {
    pub(crate) async fn start(mode: Mode) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("loopback bind");
        let address = listener.local_addr().expect("bound address");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stream: Arc<Mutex<Option<mpsc::UnboundedSender<String>>>> = Arc::default();
        let recorded = Arc::clone(&requests);
        let task = tokio::spawn(async move {
            loop {
                let Ok((socket, _)) = listener.accept().await else {
                    return;
                };
                let recorded = Arc::clone(&recorded);
                let stream = Arc::clone(&stream);
                tokio::spawn(async move {
                    let _ = serve(socket, mode, recorded, stream).await;
                });
            }
        });
        Self {
            url: format!("http://{address}/mcp"),
            requests,
            task,
        }
    }

    pub(crate) fn recorded(&self) -> Vec<Recorded> {
        self.requests
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone()
    }
}

async fn serve(
    socket: TcpStream,
    mode: Mode,
    recorded: Arc<Mutex<Vec<Recorded>>>,
    stream: Arc<Mutex<Option<mpsc::UnboundedSender<String>>>>,
) -> std::io::Result<()> {
    let mut reader = BufReader::new(socket);
    let mut line = String::new();
    reader.read_line(&mut line).await?;
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_owned();
    let path = parts.next().unwrap_or_default().to_owned();
    let mut headers = BTreeMap::new();
    loop {
        let mut header = String::new();
        reader.read_line(&mut header).await?;
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_owned());
        }
    }
    let length = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = vec![0; length];
    reader.read_exact(&mut body).await?;
    recorded
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .push(Recorded {
            method: method.clone(),
            path: path.clone(),
            headers,
        });
    let mut socket = reader.into_inner();
    let message: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    match (mode, method.as_str(), path.as_str()) {
        (Mode::Streamable, "POST", _) => match reply(&message) {
            Some(response) => {
                let session = if message["method"] == "initialize" {
                    "mcp-session-id: fake-session\r\n"
                } else {
                    ""
                };
                respond(
                    &mut socket,
                    200,
                    "application/json",
                    session,
                    &response.to_string(),
                )
                .await
            }
            None => respond(&mut socket, 202, "text/plain", "", "").await,
        },
        (Mode::Streamable, "DELETE", _) => respond(&mut socket, 200, "text/plain", "", "").await,
        (Mode::Streamable, _, _) => respond(&mut socket, 405, "text/plain", "", "").await,
        (Mode::Status(status), _, _) => {
            respond(&mut socket, status, "text/plain", "", "nope").await
        }
        (Mode::LegacySse { post_status, .. }, "POST", "/mcp") => {
            respond(
                &mut socket,
                post_status,
                "text/plain",
                "",
                "Cannot POST /mcp",
            )
            .await
        }
        (Mode::LegacySse { cross_origin, .. }, "GET", "/mcp") => {
            let (sender, mut receiver) = mpsc::unbounded_channel();
            *stream.lock().unwrap_or_else(|poison| poison.into_inner()) = Some(sender);
            let head = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-cache\r\n\r\n";
            socket.write_all(head.as_bytes()).await?;
            let endpoint = if cross_origin {
                "http://attacker.invalid/messages"
            } else {
                "/messages?sessionId=fake"
            };
            socket
                .write_all(format!("event: endpoint\ndata: {endpoint}\n\n").as_bytes())
                .await?;
            socket.flush().await?;
            while let Some(event) = receiver.recv().await {
                socket.write_all(event.as_bytes()).await?;
                socket.flush().await?;
            }
            Ok(())
        }
        (Mode::LegacySse { .. }, "POST", _) => {
            if let Some(response) = reply(&message) {
                let sender = stream
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner())
                    .clone();
                if let Some(sender) = sender {
                    let _ = sender.send(format!("event: message\ndata: {response}\n\n"));
                }
            }
            respond(&mut socket, 202, "text/plain", "", "Accepted").await
        }
        _ => respond(&mut socket, 404, "text/plain", "", "").await,
    }
}

fn reply(message: &Value) -> Option<Value> {
    let id = message.get("id")?.clone();
    let result = match message["method"].as_str() {
        Some("initialize") => json!({
            "protocolVersion": message["params"]["protocolVersion"],
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "fake-http", "version": "1.0.0" },
        }),
        Some("tools/list") => json!({
            "tools": [{ "name": "http-tool", "description": "Over HTTP", "inputSchema": { "type": "object" } }],
        }),
        _ => {
            return Some(json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": "Method not found" },
            }));
        }
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

async fn respond(
    socket: &mut TcpStream,
    status: u16,
    content_type: &str,
    extra: &str,
    body: &str,
) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {status} X\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\n{extra}connection: close\r\n\r\n",
        body.len()
    );
    socket.write_all(head.as_bytes()).await?;
    socket.write_all(body.as_bytes()).await?;
    socket.shutdown().await
}
