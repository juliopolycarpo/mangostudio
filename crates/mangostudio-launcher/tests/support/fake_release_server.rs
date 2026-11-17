//! A named fake of the release asset host, shared by the launcher's unit tests
//! (`src/main.rs`, through `#[path]`) and its process-level tests. It serves
//! fixed bodies over plain HTTP on a loopback port, answers 404 for any path
//! nobody registered, and records every request line so a test can assert how
//! many requests a launcher start made and to which asset.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

#[derive(Clone)]
struct Route {
    status: u16,
    body: Vec<u8>,
    delay: Duration,
    /// Send the body in this many chunks with this pause between them.
    trickle: Option<(usize, Duration)>,
}

pub struct FakeReleaseServer {
    address: SocketAddr,
    routes: Arc<Mutex<HashMap<String, Route>>>,
    requests: Arc<Mutex<Vec<String>>>,
    stopping: Arc<AtomicBool>,
    acceptor: Option<JoinHandle<()>>,
}

impl FakeReleaseServer {
    pub fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .expect("expected the fake release server to bind a loopback port");
        let address = listener
            .local_addr()
            .expect("expected the bound listener to report its address");
        let routes: Arc<Mutex<HashMap<String, Route>>> = Arc::default();
        let requests: Arc<Mutex<Vec<String>>> = Arc::default();
        let stopping = Arc::new(AtomicBool::new(false));

        let acceptor = {
            let routes = Arc::clone(&routes);
            let requests = Arc::clone(&requests);
            let stopping = Arc::clone(&stopping);
            thread::spawn(move || {
                for stream in listener.incoming() {
                    if stopping.load(Ordering::SeqCst) {
                        return;
                    }
                    let Ok(stream) = stream else { continue };
                    let routes = Arc::clone(&routes);
                    let requests = Arc::clone(&requests);
                    // One thread per connection: a deliberately slow archive
                    // response must not hold up a concurrent SHA256SUMS request.
                    thread::spawn(move || answer(stream, &routes, &requests));
                }
            })
        };

        Self {
            address,
            routes,
            requests,
            stopping,
            acceptor: Some(acceptor),
        }
    }

    pub fn base_url(&self) -> String {
        format!("http://{}", self.address)
    }

    /// Serve `body` with status 200 at `path` (for example `/SHA256SUMS`),
    /// replacing whatever was registered there.
    pub fn serve(&self, path: &str, body: Vec<u8>) {
        self.register(path, 200, body, Duration::ZERO);
    }

    /// Like [`Self::serve`], but hold the response back for `delay` so two
    /// concurrent clients are both inside the request before either finishes.
    pub fn serve_slowly(&self, path: &str, body: Vec<u8>, delay: Duration) {
        self.register(path, 200, body, delay);
    }

    /// Accept the request and never answer it, the way a stalled connection
    /// looks to a client without a deadline. The handler thread ends on its own.
    pub fn serve_hanging(&self, path: &str) {
        self.register(path, 200, Vec::new(), Duration::from_secs(20));
    }

    /// Answer at once but send the body in `chunks` pieces with `pause` between
    /// them: a slow link that never goes quiet. The whole transfer takes about
    /// `chunks * pause`, longer than a per-read deadline set just above `pause`.
    pub fn serve_trickling(&self, path: &str, body: Vec<u8>, chunks: usize, pause: Duration) {
        self.routes
            .lock()
            .expect("expected the route table lock to be healthy")
            .insert(
                path.to_string(),
                Route {
                    status: 200,
                    body,
                    delay: Duration::ZERO,
                    trickle: Some((chunks, pause)),
                },
            );
    }

    pub fn serve_status(&self, path: &str, status: u16) {
        self.register(path, status, Vec::new(), Duration::ZERO);
    }

    fn register(&self, path: &str, status: u16, body: Vec<u8>, delay: Duration) {
        self.routes
            .lock()
            .expect("expected the route table lock to be healthy")
            .insert(
                path.to_string(),
                Route {
                    status,
                    body,
                    delay,
                    trickle: None,
                },
            );
    }

    /// Every request line received so far, such as `GET /SHA256SUMS`.
    pub fn requests(&self) -> Vec<String> {
        self.requests
            .lock()
            .expect("expected the request log lock to be healthy")
            .clone()
    }

    pub fn request_count(&self, path: &str) -> usize {
        let wanted = format!("GET {path}");
        self.requests()
            .iter()
            .filter(|line| **line == wanted)
            .count()
    }

    pub fn forget_requests(&self) {
        self.requests
            .lock()
            .expect("expected the request log lock to be healthy")
            .clear();
    }
}

impl Drop for FakeReleaseServer {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::SeqCst);
        // `incoming()` blocks in accept; one throwaway connection wakes it.
        let _ = TcpStream::connect(self.address);
        if let Some(acceptor) = self.acceptor.take() {
            let _ = acceptor.join();
        }
    }
}

/// A host that accepts every connection and closes it unanswered, so a request
/// fails at once the way it does on a dead network. Its listener stays bound
/// for the life of the value: a port released and re-bound by a parallel test
/// would turn the failure into someone else's server.
pub struct ClosedConnectionServer {
    address: SocketAddr,
    stopping: Arc<AtomicBool>,
    acceptor: Option<JoinHandle<()>>,
}

impl ClosedConnectionServer {
    pub fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .expect("expected the closing server to bind a loopback port");
        let address = listener
            .local_addr()
            .expect("expected the bound listener to report its address");
        let stopping = Arc::new(AtomicBool::new(false));
        let acceptor = {
            let stopping = Arc::clone(&stopping);
            thread::spawn(move || {
                for stream in listener.incoming() {
                    if stopping.load(Ordering::SeqCst) {
                        return;
                    }
                    drop(stream);
                }
            })
        };
        Self {
            address,
            stopping,
            acceptor: Some(acceptor),
        }
    }

    pub fn base_url(&self) -> String {
        format!("http://{}", self.address)
    }
}

impl Drop for ClosedConnectionServer {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(self.address);
        if let Some(acceptor) = self.acceptor.take() {
            let _ = acceptor.join();
        }
    }
}

fn answer(
    stream: TcpStream,
    routes: &Mutex<HashMap<String, Route>>,
    requests: &Mutex<Vec<String>>,
) {
    let mut reader = BufReader::new(&stream);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
        return;
    }
    // Drain the headers so the client is not reset mid-write.
    loop {
        let mut header = String::new();
        match reader.read_line(&mut header) {
            Ok(0) | Err(_) => break,
            Ok(_) if header == "\r\n" || header == "\n" => break,
            Ok(_) => {}
        }
    }
    let mut fields = request_line.split_whitespace();
    let method = fields.next().unwrap_or("").to_string();
    let path = fields.next().unwrap_or("/").to_string();
    // Logged without the protocol version: `GET /SHA256SUMS`.
    requests
        .lock()
        .expect("expected the request log lock to be healthy")
        .push(format!("{method} {path}"));

    let route = routes
        .lock()
        .expect("expected the route table lock to be healthy")
        .get(&path)
        .cloned()
        .unwrap_or(Route {
            status: 404,
            body: Vec::new(),
            delay: Duration::ZERO,
            trickle: None,
        });
    thread::sleep(route.delay);

    let reason = match route.status {
        200 => "OK",
        404 => "Not Found",
        _ => "Status",
    };
    let head = format!(
        "HTTP/1.1 {} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        route.status,
        route.body.len()
    );
    let mut stream = &stream;
    let _ = stream.write_all(head.as_bytes());
    match route.trickle {
        Some((chunks, pause)) if chunks > 0 => {
            let size = route.body.len().div_ceil(chunks).max(1);
            for piece in route.body.chunks(size) {
                let _ = stream.write_all(piece);
                let _ = stream.flush();
                thread::sleep(pause);
            }
        }
        _ => {
            let _ = stream.write_all(&route.body);
        }
    }
    let _ = stream.flush();
}
