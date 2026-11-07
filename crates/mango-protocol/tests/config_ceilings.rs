//! Configuration limits fail before codecs or sessions perform I/O.

use mango_protocol::codec::ndjson::{LineDecoder, encode_line};
use mango_protocol::frame::Frame;
use mango_protocol::validate::MAX_ANNOUNCED_FRAME_BYTES;

#[test]
fn configuration_frame_ceiling_matches_wire_maximum() {
    let max = MAX_ANNOUNCED_FRAME_BYTES as usize;
    assert_eq!(LineDecoder::new(max).max_frame_bytes(), max);
    assert!(encode_line(&Frame::Ping, max).is_ok());
    assert!(encode_line(&Frame::Ping, max + 1).is_err());
    assert!(std::panic::catch_unwind(|| LineDecoder::new(max + 1)).is_err());
}

#[cfg(feature = "websocket")]
mod websocket {
    use mango_protocol::{
        codec::chunk::CHUNK_HEADER_BYTES,
        transports::websocket::{WebSocketOptions, websocket_port},
        validate::MAX_ANNOUNCED_FRAME_BYTES,
    };
    use tokio_tungstenite::{WebSocketStream, tungstenite::protocol::Role};

    #[test]
    fn websocket_config_accepts_the_maximum_without_allocating_it() {
        let max = MAX_ANNOUNCED_FRAME_BYTES as usize;
        let options = WebSocketOptions {
            max_frame_bytes: max,
            ..WebSocketOptions::default()
        };
        assert_eq!(
            options.socket_config().max_message_size,
            Some(max + CHUNK_HEADER_BYTES)
        );
    }

    #[test]
    #[should_panic(expected = "max_frame_bytes is 2147483648; expected at most 2147483647")]
    fn websocket_config_refuses_an_oversized_direct_frame_limit() {
        let options = WebSocketOptions {
            max_frame_bytes: MAX_ANNOUNCED_FRAME_BYTES as usize + 1,
            ..WebSocketOptions::default()
        };
        let _ = options.socket_config();
    }

    #[tokio::test]
    #[should_panic(expected = "max_frame_bytes is 2147483648; expected at most 2147483647")]
    async fn websocket_port_refuses_an_oversized_direct_frame_limit() {
        let (socket, _remote) = tokio::io::duplex(64);
        let stream = WebSocketStream::from_raw_socket(socket, Role::Client, None).await;
        let options = WebSocketOptions {
            max_frame_bytes: MAX_ANNOUNCED_FRAME_BYTES as usize + 1,
            ..WebSocketOptions::default()
        };
        let _ = websocket_port(stream, options);
    }
}

#[cfg(feature = "tokio")]
mod session {
    use mango_protocol::{
        frame::PeerInfo,
        port::{Port, port_pair},
        session::{Session, SessionOptions},
        validate::{MAX_ANNOUNCED_FRAME_BYTES, MAX_ANNOUNCED_IN_FLIGHT},
    };
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

    struct TrackedPort<P: Port> {
        inner: P,
        ceiling: Option<usize>,
        split: Arc<AtomicBool>,
    }

    impl<P: Port> Port for TrackedPort<P> {
        type Tx = P::Tx;
        type Rx = P::Rx;
        fn max_frame_bytes(&self) -> Option<usize> {
            self.ceiling
        }
        fn split(self) -> (Self::Tx, Self::Rx) {
            self.split.store(true, Ordering::SeqCst);
            self.inner.split()
        }
    }

    fn options() -> SessionOptions {
        SessionOptions::new(PeerInfo {
            name: "test".into(),
            version: "1".into(),
            role: "tool".into(),
        })
    }

    #[test]
    fn configuration_ceilings_are_refused_before_splitting_the_port() {
        let max = MAX_ANNOUNCED_FRAME_BYTES as usize;
        for other in [None, Some(4096), Some(max)] {
            for (requested, ceiling, count, name) in [
                (Some(max + 1), other, 1, "max_frame_bytes"),
                (other, Some(max + 1), 1, "port max_frame_bytes"),
                (
                    other,
                    other,
                    MAX_ANNOUNCED_IN_FLIGHT as usize + 1,
                    "max_in_flight",
                ),
            ] {
                let split = Arc::new(AtomicBool::new(false));
                let (inner, _remote) = port_pair();
                let port = TrackedPort {
                    inner,
                    ceiling,
                    split: split.clone(),
                };
                let mut opts = options();
                opts.max_frame_bytes = requested;
                opts.max_in_flight = count;
                let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    Session::open(port, opts)
                }))
                .err()
                .expect("oversized configuration must panic");
                let message = panic.downcast_ref::<String>().expect("named panic");
                assert!(message.starts_with(&format!("{name} is ")), "{message}");
                assert!(!split.load(Ordering::SeqCst));
            }
        }
    }

    #[tokio::test]
    async fn configuration_ceilings_keep_the_effective_port_session_minimum() {
        use mango_protocol::{
            Frame,
            frame::{Hello, Limits},
            port::{Inbound, PortRx, PortTx},
        };
        use std::time::Duration;
        let max = MAX_ANNOUNCED_FRAME_BYTES as usize;
        for (requested, ceiling, effective) in [
            (None, None, 16 * 1024 * 1024),
            (Some(max), None, max),
            (None, Some(max), max),
            (Some(max), Some(4096), 4096),
            (Some(4096), Some(max), 4096),
            (Some(max), Some(max), max),
        ] {
            let (inner, remote) = port_pair();
            let port = TrackedPort {
                inner,
                ceiling,
                split: Arc::default(),
            };
            let mut opts = options();
            opts.max_frame_bytes = requested;
            opts.max_in_flight = MAX_ANNOUNCED_IN_FLIGHT as usize;
            opts.max_stream_keys = opts.max_in_flight + 1;
            let (session, driver) = Session::spawn(port, opts);
            let (mut tx, mut rx) = remote.split();
            let hello = tokio::time::timeout(Duration::from_secs(1), rx.recv())
                .await
                .expect("hello arrives");
            let Some(Inbound::Frame(Frame::Hello(hello))) = hello else {
                panic!("expected hello")
            };
            let limits = hello.limits.expect("nondefault in-flight limit");
            assert_eq!(limits.max_in_flight, Some(MAX_ANNOUNCED_IN_FLIGHT));
            assert_eq!(
                limits.max_frame_bytes,
                (effective < 16 * 1024 * 1024).then_some(effective as u64)
            );
            let _ = tx
                .send(Frame::Hello(Hello {
                    protocol: mango_protocol::PROTOCOL_VERSION,
                    peer: options().peer,
                    capabilities: Default::default(),
                    limits: Some(Limits {
                        max_frame_bytes: Some(MAX_ANNOUNCED_FRAME_BYTES),
                        max_in_flight: None,
                    }),
                }))
                .await;
            tokio::time::timeout(Duration::from_secs(1), session.ready())
                .await
                .expect("ready settles")
                .expect("valid handshake");
            assert_eq!(session.send_limit_bytes(), effective);
            session.close_now(4000, None);
            tokio::time::timeout(Duration::from_secs(1), driver)
                .await
                .expect("driver settles")
                .expect("driver joins");
        }
    }

    #[test]
    fn configuration_builders_keep_the_wire_and_local_budgets_distinct() {
        let max = MAX_ANNOUNCED_FRAME_BYTES as usize;
        let count = MAX_ANNOUNCED_IN_FLIGHT as usize;
        let opts = options()
            .with_max_frame_bytes(max)
            .with_max_in_flight(count)
            .with_max_stream_keys(count + 1);
        assert_eq!(opts.max_frame_bytes, Some(max));
        assert_eq!(opts.max_in_flight, count);
        assert_eq!(opts.max_stream_keys, count + 1);
        assert!(std::panic::catch_unwind(|| options().with_max_frame_bytes(max + 1)).is_err());
        assert!(std::panic::catch_unwind(|| options().with_max_in_flight(count + 1)).is_err());
    }
}
