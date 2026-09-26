//! Cross-process ownership of a whole live-update transfer.
//!
//! This matches the TypeScript runtime's `runtime-update.lock` protocol, so
//! both hosts refuse a concurrent writer to the same slot. A token prevents
//! an old owner from deleting a newer owner's lock on release.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};

use crate::runtime_home::lock::{current_hostname, is_process_alive, is_windows_access_denied};

const LOCK_NAME: &str = "runtime-update.lock";
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
/// How many times an open that met a delete-pending file is tried, and how
/// long to wait between tries: about 200ms in all. See
/// [`past_delete_pending`].
const DELETE_PENDING_ATTEMPTS: u32 = 10;
const DELETE_PENDING_PAUSE: Duration = Duration::from_millis(20);

#[derive(Serialize, Deserialize)]
struct Owner {
    token: String,
    pid: u32,
    host: String,
}

/// An exclusive slot update claim. Drop checks its token before unlinking.
pub(crate) struct SlotUpdateLock {
    path: PathBuf,
    token: String,
    stop: Sender<()>,
    heartbeat: Option<JoinHandle<()>>,
}

impl SlotUpdateLock {
    /// Claims `<slot>/runtime-update.lock`; refuses a live holder and reclaims
    /// a dead same-host holder. Foreign holders require explicit cleanup,
    /// because an age check cannot fence a paused process on another host.
    pub fn acquire(slot_dir: &Path, token: String, _hold_timeout: Duration) -> io::Result<Self> {
        Self::acquire_pausing(slot_dir, token, &mut || thread::sleep(DELETE_PENDING_PAUSE))
    }

    /// [`Self::acquire`], with `pause` run between tries of an open that met
    /// a delete-pending file, so a test can end that state deterministically.
    fn acquire_pausing(
        slot_dir: &Path,
        token: String,
        pause: &mut dyn FnMut(),
    ) -> io::Result<Self> {
        fs::create_dir_all(slot_dir)?;
        let path = slot_dir.join(LOCK_NAME);
        let reclaim_path = path.with_extension("lock.reclaim");

        for attempt in 0..2 {
            // A stranded marker needs explicit operator cleanup. Removing it
            // automatically races another reclaimer's path-based unlink.
            if past_delete_pending(|| reclaim_path.try_exists(), pause)? {
                return Err(io::Error::new(
                    io::ErrorKind::WouldBlock,
                    format!(
                        "slot reclaim marker {} is present; verify no slot update is active before removing it",
                        reclaim_path.display()
                    ),
                ));
            }
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt as _;
                options.mode(0o600);
            }
            let mut file = match past_delete_pending(|| options.open(&path), pause) {
                Ok(file) => file,
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    if attempt == 0 && reclaim_abandoned(&path, &reclaim_path) {
                        continue;
                    }
                    return Err(busy(&path));
                }
                Err(error) => return Err(error),
            };
            let written = (|| -> io::Result<()> {
                let owner = Owner {
                    token: token.clone(),
                    pid: std::process::id(),
                    host: current_hostname()?,
                };
                let encoded = serde_json::to_vec(&owner).map_err(io::Error::other)?;
                file.write_all(&encoded)?;
                file.sync_all()
            })();
            if let Err(error) = written {
                drop(file);
                let _ = fs::remove_file(&path);
                return Err(error);
            }
            let heartbeat_file = match file.try_clone() {
                Ok(file) => file,
                Err(error) => {
                    drop(file);
                    let _ = fs::remove_file(&path);
                    return Err(error);
                }
            };
            drop(file);
            let (stop, stopped) = mpsc::channel();
            let heartbeat = thread::Builder::new()
                .name("runtime-update-lock-heartbeat".into())
                .spawn(move || heartbeat_loop(heartbeat_file, stopped, HEARTBEAT_INTERVAL));
            let heartbeat = match heartbeat {
                Ok(heartbeat) => heartbeat,
                Err(error) => {
                    let _ = fs::remove_file(&path);
                    return Err(error);
                }
            };
            return Ok(Self {
                path,
                token,
                stop,
                heartbeat: Some(heartbeat),
            });
        }
        Err(busy(&path))
    }
}

fn heartbeat_loop(file: File, stopped: Receiver<()>, interval: Duration) {
    while stopped
        .recv_timeout(interval)
        .is_err_and(|error| error == mpsc::RecvTimeoutError::Timeout)
    {
        let _ = file.set_modified(SystemTime::now());
    }
}

impl Drop for SlotUpdateLock {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(heartbeat) = self.heartbeat.take() {
            let _ = heartbeat.join();
        }
        if let Ok(raw) = fs::read(&self.path)
            && serde_json::from_slice::<Owner>(&raw).is_ok_and(|owner| owner.token == self.token)
        {
            let _ = fs::remove_file(&self.path);
        }
    }
}

/// Runs `open`, trying again (after `pause`, a bounded number of times)
/// while it fails the way Windows fails any open of a delete-pending file.
///
/// Removing a file on Windows only marks it for deletion while any other
/// handle to it is still open — an antivirus or indexer scanning the lock
/// or reclaim marker just written, or a concurrent reader — and every open
/// of that name fails with `ERROR_ACCESS_DENIED` until the last handle
/// closes. Without this, an update racing a lock release fails with a
/// permission error instead of claiming the slot a moment later. The
/// state cannot be told apart from a real denial through `std`, so a
/// denial that outlasts the retries is returned as it came: a slot
/// directory this process really cannot write still fails with its own
/// error, just ~200ms later. Elsewhere the name is gone the moment it is
/// removed, and `open` runs once.
///
/// Usage: `past_delete_pending(|| options.open(&path), &mut || thread::sleep(pause))`.
fn past_delete_pending<T>(
    mut open: impl FnMut() -> io::Result<T>,
    pause: &mut dyn FnMut(),
) -> io::Result<T> {
    let mut attempts = 1;
    loop {
        match open() {
            Err(error)
                if attempts < DELETE_PENDING_ATTEMPTS && is_windows_access_denied(&error) =>
            {
                pause();
                attempts += 1;
            }
            result => return result,
        }
    }
}

fn busy(path: &Path) -> io::Error {
    io::Error::new(
        io::ErrorKind::WouldBlock,
        format!(
            "another slot update owns {}; if its owner exited, verify no updater is active on any host before removing the lock",
            path.display()
        ),
    )
}

fn reclaim_abandoned(path: &Path, reclaim_path: &Path) -> bool {
    let Ok(mut reclaim) = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(reclaim_path)
    else {
        return false;
    };
    let result = (|| -> io::Result<bool> {
        let marker = Owner {
            token: format!("reclaim-{}", std::process::id()),
            pid: std::process::id(),
            host: current_hostname()?,
        };
        reclaim.write_all(&serde_json::to_vec(&marker).map_err(io::Error::other)?)?;
        reclaim.sync_all()?;
        let raw = fs::read(path)?;
        let owner = serde_json::from_slice::<Owner>(&raw).ok();
        let same_host = owner.as_ref().is_some_and(|owner| {
            current_hostname().is_ok_and(|host| owner.host.eq_ignore_ascii_case(&host))
        });
        let abandoned =
            same_host && !is_process_alive(owner.expect("same_host requires owner").pid);
        if abandoned {
            fs::remove_file(path)?;
        }
        Ok(abandoned)
    })();
    drop(reclaim);
    let _ = fs::remove_file(reclaim_path);
    result.is_ok_and(|reclaimed| reclaimed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slot(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("mango-slot-lock-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn live_claim_refuses_a_second_writer_and_drop_releases_it() {
        let dir = slot("live");
        let claim = SlotUpdateLock::acquire(&dir, "one".into(), Duration::from_secs(120)).unwrap();
        let error = SlotUpdateLock::acquire(&dir, "two".into(), Duration::from_secs(120))
            .err()
            .expect("second writer must be refused");
        assert_eq!(error.kind(), io::ErrorKind::WouldBlock);
        drop(claim);
        let next = SlotUpdateLock::acquire(&dir, "two".into(), Duration::from_secs(120)).unwrap();
        drop(next);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn dead_local_holder_is_reclaimed_and_old_token_cannot_release_replacement() {
        let dir = slot("reclaim");
        let path = dir.join(LOCK_NAME);
        let mut exited = if cfg!(windows) {
            std::process::Command::new("cmd")
                .args(["/C", "exit", "0"])
                .spawn()
                .unwrap()
        } else {
            std::process::Command::new("sh")
                .args(["-c", "exit 0"])
                .spawn()
                .unwrap()
        };
        let dead_pid = exited.id();
        exited.wait().unwrap();
        let dead = Owner {
            token: "dead".into(),
            pid: dead_pid,
            host: current_hostname().unwrap(),
        };
        fs::write(&path, serde_json::to_vec(&dead).unwrap()).unwrap();
        let claim = SlotUpdateLock::acquire(&dir, "new".into(), Duration::from_secs(120)).unwrap();
        assert_eq!(
            serde_json::from_slice::<Owner>(&fs::read(&path).unwrap())
                .unwrap()
                .token,
            "new"
        );
        fs::write(&path, serde_json::to_vec(&dead).unwrap()).unwrap();
        drop(claim);
        assert!(path.exists(), "a replaced token must not be removed");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn abandoned_reclaim_marker_requires_explicit_cleanup() {
        let dir = slot("abandoned-marker");
        let marker = dir.join("runtime-update.lock.reclaim");
        fs::write(&marker, b"").unwrap();
        OpenOptions::new()
            .write(true)
            .open(&marker)
            .unwrap()
            .set_modified(SystemTime::now() - Duration::from_secs(31))
            .unwrap();

        let error = SlotUpdateLock::acquire(&dir, "new".into(), Duration::from_secs(120))
            .err()
            .expect("even an old marker must stay exclusive");
        assert_eq!(error.kind(), io::ErrorKind::WouldBlock);
        assert!(marker.exists());
        fs::remove_file(&marker).unwrap();
        let claim = SlotUpdateLock::acquire(&dir, "new".into(), Duration::from_secs(120)).unwrap();
        drop(claim);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_aged_foreign_lock_is_not_reclaimed_without_fencing() {
        let dir = slot("foreign-owner");
        let path = dir.join(LOCK_NAME);
        fs::write(
            &path,
            serde_json::to_vec(&Owner {
                token: "foreign".into(),
                pid: 4242,
                host: "some-other-host".into(),
            })
            .unwrap(),
        )
        .unwrap();
        OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(SystemTime::now() - Duration::from_secs(3600))
            .unwrap();

        let error = SlotUpdateLock::acquire(&dir, "local".into(), Duration::from_secs(120))
            .err()
            .expect("foreign ownership must remain exclusive regardless of age");
        assert_eq!(error.kind(), io::ErrorKind::WouldBlock);
        assert!(error.to_string().contains("verify no updater is active"));
        assert_eq!(
            serde_json::from_slice::<Owner>(&fs::read(&path).unwrap())
                .unwrap()
                .token,
            "foreign"
        );
        fs::remove_dir_all(dir).unwrap();
    }

    /// An hour-old lock on this host whose body names no pid, or is not an
    /// owner record at all, cannot prove its holder is gone: neither is
    /// reclaimed, the body is left byte-for-byte, and the reclaim marker
    /// taken while weighing it is removed rather than stranded.
    #[test]
    fn an_aged_lock_with_a_missing_pid_or_an_unparseable_body_is_not_reclaimed() {
        let host = current_hostname().unwrap();
        let bodies: [(&str, Vec<u8>); 2] = [
            (
                "missing-pid",
                serde_json::to_vec(&serde_json::json!({ "token": "pidless", "host": host }))
                    .unwrap(),
            ),
            ("unparseable", b"{ not an owner record".to_vec()),
        ];
        for (name, body) in bodies {
            let dir = slot(name);
            let path = dir.join(LOCK_NAME);
            fs::write(&path, &body).unwrap();
            OpenOptions::new()
                .write(true)
                .open(&path)
                .unwrap()
                .set_modified(SystemTime::now() - Duration::from_secs(3600))
                .unwrap();

            let refused = SlotUpdateLock::acquire(&dir, "local".into(), Duration::from_secs(120));
            let kind = refused.as_ref().err().map(io::Error::kind);
            assert_eq!(
                kind,
                Some(io::ErrorKind::WouldBlock),
                "expected the {name} lock to refuse with WouldBlock | received: {:?}",
                refused
                    .as_ref()
                    .map(|_| "acquired")
                    .map_err(ToString::to_string)
            );
            let left = fs::read(&path).unwrap();
            assert_eq!(
                left,
                body,
                "expected the {name} lock body untouched | received: {:?}",
                String::from_utf8_lossy(&left)
            );
            let marker = dir.join("runtime-update.lock.reclaim");
            assert!(
                !marker.exists(),
                "expected no reclaim marker after weighing the {name} lock | received: {} present",
                marker.display()
            );
            fs::remove_dir_all(dir).unwrap();
        }
    }

    /// Any error other than a Windows access denial is returned from the
    /// first try, never retried.
    #[test]
    fn an_open_that_fails_for_another_reason_is_tried_once() {
        let mut tries = 0;
        let mut pauses = 0;
        let result: io::Result<()> = past_delete_pending(
            || {
                tries += 1;
                Err(io::Error::from(io::ErrorKind::NotFound))
            },
            &mut || pauses += 1,
        );
        let kind = result.as_ref().err().map(io::Error::kind);
        assert_eq!(
            (tries, pauses, kind),
            (1, 0, Some(io::ErrorKind::NotFound)),
            "expected (tries, pauses, error): (1, 0, Some(NotFound)) | received: ({tries}, {pauses}, {kind:?})"
        );
    }

    /// A denial that never clears is a real one: it is tried a bounded
    /// number of times and then returned unchanged, never read as busy.
    #[cfg(windows)]
    #[test]
    fn a_denial_that_outlasts_the_retries_is_returned_as_it_came() {
        let denied = i32::try_from(windows_sys::Win32::Foundation::ERROR_ACCESS_DENIED).unwrap();
        let mut tries = 0;
        let result: io::Result<()> = past_delete_pending(
            || {
                tries += 1;
                Err(io::Error::from_raw_os_error(denied))
            },
            &mut || {},
        );
        let code = result.as_ref().err().and_then(io::Error::raw_os_error);
        assert_eq!(
            (tries, code),
            (DELETE_PENDING_ATTEMPTS, Some(denied)),
            "expected (tries, os error): ({DELETE_PENDING_ATTEMPTS}, Some({denied})) | received: ({tries}, {code:?})"
        );
    }

    /// The lock a releasing holder just removed can still be delete-pending
    /// while another handle to it is open; claiming it then must wait for
    /// that handle rather than fail with `PermissionDenied`. The pending
    /// state is real: the file is opened delete-on-close beside a second
    /// handle, and the delete-on-close handle is closed first. The second
    /// handle is closed from the claim's first pause, so the retry is
    /// exercised without timing.
    #[cfg(windows)]
    #[test]
    fn a_delete_pending_lock_is_claimed_once_its_last_handle_closes() {
        use std::os::windows::fs::OpenOptionsExt as _;
        use windows_sys::Win32::Foundation::{ERROR_ACCESS_DENIED, GENERIC_READ, GENERIC_WRITE};
        use windows_sys::Win32::Storage::FileSystem::{DELETE, FILE_FLAG_DELETE_ON_CLOSE};

        let dir = slot("delete-pending");
        let path = dir.join(LOCK_NAME);
        let deleting = OpenOptions::new()
            .write(true)
            .create_new(true)
            .access_mode(GENERIC_READ | GENERIC_WRITE | DELETE)
            .custom_flags(FILE_FLAG_DELETE_ON_CLOSE)
            .open(&path)
            .unwrap();
        let mut lingering = Some(OpenOptions::new().read(true).open(&path).unwrap());
        drop(deleting);
        let setup = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map(drop);
        let denied = i32::try_from(ERROR_ACCESS_DENIED).unwrap();
        assert_eq!(
            setup.as_ref().err().and_then(io::Error::raw_os_error),
            Some(denied),
            "expected the lock delete-pending (os error {denied}) before claiming | received: {setup:?}"
        );

        let mut pauses = 0;
        let claim = SlotUpdateLock::acquire_pausing(&dir, "after-release".into(), &mut || {
            pauses += 1;
            drop(lingering.take());
        });
        let received = claim
            .as_ref()
            .map(|_| "claimed")
            .map_err(ToString::to_string);
        assert!(
            claim.is_ok(),
            "expected the delete-pending lock claimed once its last handle closed | received: {received:?}"
        );
        assert!(
            pauses >= 1,
            "expected the claim to wait out the delete-pending lock | received: {pauses} pauses"
        );
        drop(claim);
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn heartbeat_renews_only_the_original_lock_inode() {
        let dir = slot("heartbeat-inode");
        let path = dir.join(LOCK_NAME);
        fs::write(&path, b"old owner").unwrap();
        let file = OpenOptions::new().write(true).open(&path).unwrap();
        let (stop, stopped) = mpsc::channel();
        let heartbeat = thread::spawn(move || {
            heartbeat_loop(file, stopped, Duration::from_millis(10));
        });
        let old = SystemTime::now() - Duration::from_secs(600);
        OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(old)
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(1);
        while fs::metadata(&path).unwrap().modified().unwrap() <= old {
            assert!(std::time::Instant::now() < deadline);
            thread::sleep(Duration::from_millis(5));
        }

        fs::rename(&path, dir.join("retired-lock")).unwrap();
        fs::write(&path, b"replacement owner").unwrap();
        OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(old)
            .unwrap();
        thread::sleep(Duration::from_millis(30));
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), old);
        stop.send(()).unwrap();
        heartbeat.join().unwrap();
        fs::remove_dir_all(dir).unwrap();
    }
}
