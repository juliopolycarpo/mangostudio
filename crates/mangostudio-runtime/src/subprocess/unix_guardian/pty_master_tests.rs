//! Runs `PtyReader` and `PtyWriter` over a real PTY master from `open_pty`. The pipe-backed test
//! in the parent module proves the reactor registration; only a PTY master is the character
//! device the wrappers exist for, with a line discipline, a slave side that can hang up, and
//! `EIO` on read once that happens.
//!
//! Every wait on the kernel is a hang bound: a missing byte or hangup fails with the condition
//! that never arrived instead of blocking the test run.

use std::io;
use std::os::fd::{AsRawFd, OwnedFd};
use std::time::{Duration, Instant};

use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::{PtyReader, PtyWriter, open_pty, register_pty_fd, set_nonblocking};

/// Upper bound for any single wait on the kernel; a healthy PTY answers in microseconds.
const HANG_BOUND: Duration = Duration::from_secs(10);

/// The master side as production wires it: one descriptor per wrapper, both nonblocking, both
/// registered with the reactor.
struct WrappedMaster {
    reader: PtyReader,
    writer: PtyWriter,
}

/// Opens a PTY and wraps its master. The returned slave stands in for the child's terminal.
///
/// Usage: `let (mut master, slave) = open_wrapped_pty(80, 24);`
fn open_wrapped_pty(cols: u16, rows: u16) -> (WrappedMaster, OwnedFd) {
    let (master, slave) = open_pty(cols, rows).expect("open_pty opens a PTY pair");
    let input = master
        .try_clone()
        .expect("master duplicates for the writer");
    set_nonblocking(&master).expect("master is nonblocking");
    set_nonblocking(&input).expect("duplicated master is nonblocking");
    let reader = PtyReader(register_pty_fd(master).expect("the reactor accepts a PTY master"));
    let writer = PtyWriter(register_pty_fd(input).expect("the reactor accepts a PTY master"));
    (WrappedMaster { reader, writer }, slave)
}

/// Puts the slave in raw mode, or in the cooked defaults the kernel gives a new terminal.
fn set_slave_mode(slave: &OwnedFd, raw: bool) {
    // SAFETY: `termios` is a plain C structure that `tcgetattr` fills before it is read.
    let mut attributes: libc::termios = unsafe { std::mem::zeroed() };
    // SAFETY: `slave` is a valid terminal descriptor and `attributes` is valid storage.
    assert_eq!(
        unsafe { libc::tcgetattr(slave.as_raw_fd(), &raw mut attributes) },
        0,
        "tcgetattr on the slave failed: {}",
        io::Error::last_os_error()
    );
    if raw {
        // SAFETY: `attributes` is a valid, initialized `termios`.
        unsafe { libc::cfmakeraw(&raw mut attributes) };
    } else {
        attributes.c_iflag |= libc::ICRNL;
        attributes.c_oflag |= libc::OPOST | libc::ONLCR;
        attributes.c_lflag |= libc::ECHO | libc::ICANON;
    }
    // SAFETY: `slave` is a valid terminal descriptor and `attributes` is initialized.
    assert_eq!(
        unsafe { libc::tcsetattr(slave.as_raw_fd(), libc::TCSANOW, &raw const attributes) },
        0,
        "tcsetattr on the slave failed: {}",
        io::Error::last_os_error()
    );
}

/// Polls the slave for `events` until the hang bound, returning the reported `revents`.
fn poll_slave(slave: &OwnedFd, events: libc::c_short, condition: &str) -> libc::c_short {
    let deadline = Instant::now() + HANG_BOUND;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let mut descriptor = libc::pollfd {
            fd: slave.as_raw_fd(),
            events,
            revents: 0,
        };
        let timeout = i32::try_from(remaining.as_millis()).unwrap_or(i32::MAX);
        // SAFETY: `descriptor` is one valid `pollfd` for the duration of the call.
        let ready = unsafe { libc::poll(&raw mut descriptor, 1, timeout) };
        if ready > 0 {
            return descriptor.revents;
        }
        let error = io::Error::last_os_error();
        assert!(
            ready == 0 || error.kind() == io::ErrorKind::Interrupted,
            "(slave poll): expected {condition} | received: poll failed: {error}"
        );
        assert!(
            Instant::now() < deadline,
            "(slave poll): expected {condition} within {HANG_BOUND:?} | received: nothing"
        );
    }
}

/// Reads exactly `length` bytes from the slave.
fn read_slave_exact(slave: &OwnedFd, length: usize) -> Vec<u8> {
    let mut received = Vec::with_capacity(length);
    while received.len() < length {
        poll_slave(
            slave,
            libc::POLLIN,
            &format!("{length} bytes on the slave, got {received:?}"),
        );
        let mut chunk = vec![0_u8; length - received.len()];
        // SAFETY: `chunk` is valid writable storage for its full length.
        let read = unsafe { libc::read(slave.as_raw_fd(), chunk.as_mut_ptr().cast(), chunk.len()) };
        assert!(
            read > 0,
            "(slave read): expected {length} bytes | received: {read} after {received:?} ({})",
            io::Error::last_os_error()
        );
        received.extend_from_slice(&chunk[..read as usize]);
    }
    received
}

fn write_slave(slave: &OwnedFd, bytes: &[u8]) {
    // SAFETY: `bytes` is valid for its full length.
    let written = unsafe { libc::write(slave.as_raw_fd(), bytes.as_ptr().cast(), bytes.len()) };
    assert_eq!(
        written,
        bytes.len() as isize,
        "(slave write): expected {} bytes written | received: {written} ({})",
        bytes.len(),
        io::Error::last_os_error()
    );
}

async fn read_master_exact(reader: &mut PtyReader, length: usize) -> Vec<u8> {
    let mut received = vec![0_u8; length];
    tokio::time::timeout(HANG_BOUND, reader.read_exact(&mut received))
        .await
        .unwrap_or_else(|_| {
            panic!("(PtyReader): expected {length} bytes within {HANG_BOUND:?} | received: nothing")
        })
        .unwrap_or_else(|error| {
            panic!("(PtyReader): expected {length} bytes | received: error {error}")
        });
    received
}

/// `PtyWriter` bytes arrive on the slave and slave bytes arrive through `PtyReader`, untouched
/// once the slave is raw.
#[tokio::test]
async fn real_pty_master_carries_raw_bytes_to_the_slave_and_back() {
    let (mut master, slave) = open_wrapped_pty(80, 24);
    set_slave_mode(&slave, true);

    master
        .writer
        .write_all(b"to-slave\x03\x04")
        .await
        .expect("PtyWriter writes to a PTY master");
    let on_slave = read_slave_exact(&slave, 10);
    assert_eq!(
        on_slave, b"to-slave\x03\x04",
        "(slave): expected the master's bytes unchanged in raw mode | received: {on_slave:?}"
    );

    write_slave(&slave, b"to-master\r\n");
    let on_master = read_master_exact(&mut master.reader, 11).await;
    assert_eq!(
        on_master, b"to-master\r\n",
        "(PtyReader): expected the slave's bytes unchanged in raw mode | received: {on_master:?}"
    );
}

/// In cooked mode the kernel's line discipline answers on its own: it echoes the typed line back
/// to the master with a CRLF, and hands the slave the line with its newline.
#[tokio::test]
async fn real_pty_master_shows_the_line_discipline_echo() {
    let (mut master, slave) = open_wrapped_pty(80, 24);
    set_slave_mode(&slave, false);

    master
        .writer
        .write_all(b"hi\n")
        .await
        .expect("PtyWriter writes a line");

    let echoed = read_master_exact(&mut master.reader, 4).await;
    assert_eq!(
        echoed, b"hi\r\n",
        "(PtyReader): expected the cooked-mode echo `hi\\r\\n` | received: {echoed:?}"
    );
    let line = read_slave_exact(&slave, 3);
    assert_eq!(
        line, b"hi\n",
        "(slave): expected the canonical line `hi\\n` | received: {line:?}"
    );
}

/// Output the slave wrote before it closed is still delivered, then every further read fails
/// with `EIO` rather than waiting for a byte that cannot come. `read_output` in `terminal::pty`
/// treats that error as the end of the stream.
///
/// Linux-only: the `EIO` hangup read and the drain-before-hangup order are Linux tty behavior;
/// other Unixes report end of file or may drop unread slave output on close.
#[cfg(any(target_os = "linux", target_os = "android"))]
#[tokio::test]
async fn real_pty_reader_drains_pending_output_then_reports_hangup() {
    let (mut master, slave) = open_wrapped_pty(80, 24);
    set_slave_mode(&slave, true);
    write_slave(&slave, b"tail");
    drop(slave);

    let drained = read_master_exact(&mut master.reader, 4).await;
    assert_eq!(
        drained, b"tail",
        "(PtyReader): expected the bytes written before the slave closed | received: {drained:?}"
    );

    let mut buffer = [0_u8; 16];
    for step in ["first read after drain", "repeated read after drain"] {
        let outcome = tokio::time::timeout(HANG_BOUND, master.reader.read(&mut buffer))
            .await
            .unwrap_or_else(|_| {
                panic!(
                    "(PtyReader {step}): expected a hangup result within {HANG_BOUND:?} | \
                     received: the read stayed pending"
                )
            });
        let eio = outcome.as_ref().err().and_then(io::Error::raw_os_error) == Some(libc::EIO);
        assert!(
            eio,
            "(PtyReader {step}): expected Err(EIO) after the slave closed | received: {outcome:?}"
        );
    }
}

/// Dropping both wrappers closes every master descriptor the process held, which the slave sees
/// as a hangup. A leaked duplicate would keep the master open and the slave quiet.
///
/// Linux-only: `POLLHUP` on a slave whose master closed is the behavior verified there.
#[cfg(any(target_os = "linux", target_os = "android"))]
#[tokio::test]
async fn dropping_the_pty_wrappers_hangs_up_the_slave() {
    let (master, slave) = open_wrapped_pty(80, 24);

    let before = poll_slave(
        &slave,
        libc::POLLOUT,
        "a writable slave while the master is open",
    );
    assert_eq!(
        before & libc::POLLHUP,
        0,
        "(slave): expected no hangup while the wrappers own the master | received: revents {before:#x}"
    );

    drop(master);

    let after = poll_slave(
        &slave,
        libc::POLLIN,
        "a slave hangup once the wrappers dropped",
    );
    assert_ne!(
        after & libc::POLLHUP,
        0,
        "(slave): expected POLLHUP after dropping PtyReader and PtyWriter | received: revents {after:#x}"
    );
}

/// `TIOCSWINSZ` on the master, as `GuardianChild::resize` issues it, reaches the slave's
/// `TIOCGWINSZ` through the duplicated master the wrappers do not own.
#[tokio::test]
async fn real_pty_window_size_set_on_a_master_duplicate_is_read_from_the_slave() {
    let (master, slave) = open_pty(80, 24).expect("open_pty opens a PTY pair");
    let resize = master.try_clone().expect("master duplicates for resize");
    set_nonblocking(&master).expect("master is nonblocking");
    // Production keeps the wrapped master registered while a resize runs on the duplicate.
    let _reader = PtyReader(register_pty_fd(master).expect("the reactor accepts a PTY master"));

    let slave_size = |slave: &OwnedFd| {
        let mut size: libc::winsize = libc::winsize {
            ws_row: 0,
            ws_col: 0,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        // SAFETY: `slave` is a valid terminal and `size` is valid output storage.
        assert_eq!(
            unsafe { libc::ioctl(slave.as_raw_fd(), libc::TIOCGWINSZ, &raw mut size) },
            0,
            "TIOCGWINSZ on the slave failed: {}",
            io::Error::last_os_error()
        );
        (size.ws_col, size.ws_row)
    };
    assert_eq!(
        slave_size(&slave),
        (80, 24),
        "(slave): expected the size open_pty was given as (cols, rows)"
    );

    let resized = libc::winsize {
        ws_row: 43,
        ws_col: 101,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    // SAFETY: `resize` is a valid PTY master and `resized` has the platform layout.
    assert_eq!(
        unsafe { libc::ioctl(resize.as_raw_fd(), libc::TIOCSWINSZ, &raw const resized) },
        0,
        "TIOCSWINSZ on the master duplicate failed: {}",
        io::Error::last_os_error()
    );
    assert_eq!(
        slave_size(&slave),
        (101, 43),
        "(slave): expected the resized (cols, rows) after TIOCSWINSZ on the master duplicate"
    );
}
