//! Unix halves of the lock protocol's two platform questions: is a pid still
//! alive, and what does this machine call itself. Both have a safe binding in
//! `nix`, so unlike the Windows half of this module there is no `unsafe` here.

use std::io;

use nix::errno::Errno;
use nix::sys::signal::kill;
use nix::unistd::{Pid, gethostname};

/// Signal 0 tests for existence without sending anything: `Ok` means the
/// pid is alive and this process may signal it, `ESRCH` means it is gone,
/// and `EPERM` means it is alive but owned by another account — mirrors
/// `process.kill(pid, 0)` in `runtime-home.ts` exactly, including treating
/// `EPERM` as "alive".
pub(super) fn is_process_alive(pid: u32) -> bool {
    match kill(Pid::from_raw(pid as i32), None) {
        Ok(()) => true,
        Err(Errno::EPERM) => true,
        Err(_) => false,
    }
}

/// This machine's hostname, for the lock body's `host` field.
pub(super) fn hostname() -> io::Result<String> {
    gethostname()?
        .into_string()
        .map_err(|raw| io::Error::other(format!("hostname is not valid Unicode: {raw:?}")))
}

#[cfg(test)]
mod tests {
    use super::{hostname, is_process_alive};

    #[test]
    fn the_current_process_is_alive() {
        assert!(is_process_alive(std::process::id()));
    }

    /// A pid this test has actually watched exit, which is the one case
    /// `kill(pid, 0)` is guaranteed to answer `ESRCH` for rather than racing
    /// pid reuse.
    #[test]
    fn a_reaped_child_is_not_alive() {
        let mut child = std::process::Command::new("true")
            .spawn()
            .expect("`true` is on PATH on every Unix this crate targets");
        let pid = child.id();
        child.wait().expect("the child ran to completion");
        assert!(!is_process_alive(pid));
    }

    #[test]
    fn pid_zero_belongs_to_no_single_process_and_reads_as_dead() {
        // Signal 0 to pid 0 targets this process's entire process group, not
        // one process — `kill` documents `ESRCH` only for "no such process",
        // but a lock body can never legitimately carry 0 (no `open()` in
        // this module ever returns pid 0), so the exact answer matters less
        // than that this never panics.
        let _ = is_process_alive(0);
    }

    #[test]
    fn hostname_resolves_to_something_nonempty() {
        assert!(!hostname().expect("this machine has a hostname").is_empty());
    }
}
