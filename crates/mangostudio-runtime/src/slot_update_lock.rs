//! Cross-process ownership of a whole live-update transfer.
//!
//! This matches the TypeScript runtime's `runtime-update.lock` protocol, so
//! both hosts refuse a concurrent writer to the same slot. A token prevents
//! an expired owner from deleting a newer owner's lock on release.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};

use crate::runtime_home::lock::{current_hostname, is_process_alive};

const LOCK_NAME: &str = "runtime-update.lock";
const STALE_FLOOR: Duration = Duration::from_secs(5 * 60);

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
}

impl SlotUpdateLock {
    /// Claims `<slot>/runtime-update.lock`; refuses a live holder and reclaims
    /// a dead same-host holder or a sufficiently old foreign-host holder.
    pub fn acquire(slot_dir: &Path, token: String, hold_timeout: Duration) -> io::Result<Self> {
        fs::create_dir_all(slot_dir)?;
        let path = slot_dir.join(LOCK_NAME);
        let reclaim_path = path.with_extension("lock.reclaim");
        let stale_after = STALE_FLOOR.max(hold_timeout.saturating_mul(2));

        for attempt in 0..2 {
            if reclaim_path.try_exists()? {
                return Err(busy(&path));
            }
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt as _;
                options.mode(0o600);
            }
            let mut file = match options.open(&path) {
                Ok(file) => file,
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    if attempt == 0 && reclaim_abandoned(&path, &reclaim_path, stale_after) {
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
            drop(file);
            if let Err(error) = written {
                let _ = fs::remove_file(&path);
                return Err(error);
            }
            return Ok(Self { path, token });
        }
        Err(busy(&path))
    }
}

impl Drop for SlotUpdateLock {
    fn drop(&mut self) {
        if let Ok(raw) = fs::read(&self.path)
            && serde_json::from_slice::<Owner>(&raw).is_ok_and(|owner| owner.token == self.token)
        {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn busy(path: &Path) -> io::Error {
    io::Error::new(
        io::ErrorKind::WouldBlock,
        format!("another slot update owns {}", path.display()),
    )
}

fn reclaim_abandoned(path: &Path, reclaim_path: &Path, stale_after: Duration) -> bool {
    let Ok(reclaim) = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(reclaim_path)
    else {
        return false;
    };
    let result = (|| -> io::Result<bool> {
        let raw = fs::read(path)?;
        let metadata = fs::metadata(path)?;
        let owner = serde_json::from_slice::<Owner>(&raw).ok();
        let same_host = owner.as_ref().is_some_and(|owner| {
            current_hostname().is_ok_and(|host| owner.host.eq_ignore_ascii_case(&host))
        });
        let abandoned = if same_host {
            !is_process_alive(owner.as_ref().expect("same_host requires owner").pid)
        } else {
            SystemTime::now()
                .duration_since(metadata.modified()?)
                .unwrap_or(Duration::ZERO)
                > stale_after
        };
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
}
