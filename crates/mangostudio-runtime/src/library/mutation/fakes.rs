//! Named fault fixtures for the mutation engines: a filesystem that runs on
//! the real disk but can fail one chosen operation, run a hook just before
//! one (to swap a path or fire a cancellation at an exact step), and pin a
//! set directory's mtime so retention order is deterministic on every
//! platform; and a hasher that can report a chosen digest or failure.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use super::disk::{
    CopyPurpose, EntryType, MutationFs, NativeHasher, NativeMutationFs, ResourceHasher,
};
use super::hashing::HashError;
use super::paths::ResourceKind;

/// Which seam operation a fault or hook targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FsOp {
    Copy(CopyPurpose),
    Rename,
    Remove,
    WriteFile,
    WriteText,
    Exists,
}

type Hook = Arc<dyn Fn(&Path) + Send + Sync>;

struct Fault {
    op: FsOp,
    path_contains: String,
    skip: usize,
    once: bool,
}

/// See the module docs.
#[derive(Default)]
pub(crate) struct ScriptedFs {
    faults: Mutex<Vec<Fault>>,
    hooks: Mutex<Vec<(FsOp, String, Hook)>>,
    mtimes: Mutex<HashMap<PathBuf, f64>>,
    log: Mutex<Vec<(FsOp, PathBuf)>>,
}

impl ScriptedFs {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Fails every `op` whose path contains `path_contains`, after letting
    /// `skip` matching calls through.
    pub(crate) fn fail(&self, op: FsOp, path_contains: &str, skip: usize) {
        self.push_fault(op, path_contains, skip, false);
    }

    /// Fails exactly one matching call, then behaves normally again.
    pub(crate) fn fail_once(&self, op: FsOp, path_contains: &str) {
        self.push_fault(op, path_contains, 0, true);
    }

    fn push_fault(&self, op: FsOp, path_contains: &str, skip: usize, once: bool) {
        self.faults.lock().unwrap().push(Fault {
            op,
            path_contains: path_contains.to_string(),
            skip,
            once,
        });
    }

    /// Runs `hook` just before every matching call.
    pub(crate) fn before(
        &self,
        op: FsOp,
        path_contains: &str,
        hook: impl Fn(&Path) + Send + Sync + 'static,
    ) {
        self.hooks
            .lock()
            .unwrap()
            .push((op, path_contains.to_string(), Arc::new(hook)));
    }

    /// Reports `mtime_ms` for `path` from [`MutationFs::stat`].
    pub(crate) fn pin_mtime(&self, path: &Path, mtime_ms: f64) {
        self.mtimes
            .lock()
            .unwrap()
            .insert(path.to_path_buf(), mtime_ms);
    }

    /// How many calls of `op` touched a path containing `path_contains`.
    pub(crate) fn count(&self, op: FsOp, path_contains: &str) -> usize {
        self.log
            .lock()
            .unwrap()
            .iter()
            .filter(|(logged, path)| {
                *logged == op && path.to_string_lossy().contains(path_contains)
            })
            .count()
    }

    fn enter(&self, op: FsOp, path: &Path) -> io::Result<()> {
        self.log.lock().unwrap().push((op, path.to_path_buf()));
        let text = path.to_string_lossy().into_owned();
        let hooks: Vec<Hook> = self
            .hooks
            .lock()
            .unwrap()
            .iter()
            .filter(|(hooked, contains, _)| *hooked == op && text.contains(contains.as_str()))
            .map(|(_, _, hook)| Arc::clone(hook))
            .collect();
        for hook in hooks {
            hook(path);
        }
        let mut faults = self.faults.lock().unwrap();
        let Some(index) = faults
            .iter()
            .position(|fault| fault.op == op && text.contains(fault.path_contains.as_str()))
        else {
            return Ok(());
        };
        if faults[index].skip > 0 {
            faults[index].skip -= 1;
            return Ok(());
        }
        if faults[index].once {
            faults.remove(index);
        }
        Err(io::Error::other(format!(
            "injected {op:?} failure at {text}"
        )))
    }
}

impl MutationFs for ScriptedFs {
    fn copy_tree(&self, source: &Path, destination: &Path, purpose: CopyPurpose) -> io::Result<()> {
        self.enter(FsOp::Copy(purpose), destination)?;
        NativeMutationFs.copy_tree(source, destination, purpose)
    }

    fn exists(&self, path: &Path) -> io::Result<bool> {
        self.enter(FsOp::Exists, path)?;
        NativeMutationFs.exists(path)
    }

    fn create_dir_all(&self, path: &Path) -> io::Result<()> {
        NativeMutationFs.create_dir_all(path)
    }

    fn rename(&self, source: &Path, destination: &Path) -> io::Result<()> {
        self.enter(FsOp::Rename, destination)?;
        NativeMutationFs.rename(source, destination)
    }

    fn remove_all(&self, path: &Path) -> io::Result<()> {
        self.enter(FsOp::Remove, path)?;
        NativeMutationFs.remove_all(path)
    }

    fn write_file_atomic(&self, path: &str, contents: &[u8]) -> io::Result<()> {
        self.enter(FsOp::WriteFile, Path::new(path))?;
        NativeMutationFs.write_file_atomic(path, contents)
    }

    fn write_text(&self, path: &Path, contents: &str) -> io::Result<()> {
        self.enter(FsOp::WriteText, path)?;
        NativeMutationFs.write_text(path, contents)
    }

    fn read_text(&self, path: &Path) -> io::Result<String> {
        NativeMutationFs.read_text(path)
    }

    fn read_dir(&self, path: &Path) -> io::Result<Vec<(String, EntryType)>> {
        NativeMutationFs.read_dir(path)
    }

    fn stat(&self, path: &Path) -> io::Result<(u64, f64)> {
        let (size, mtime) = NativeMutationFs.stat(path)?;
        let pinned = self.mtimes.lock().unwrap().get(path).copied();
        Ok((size, pinned.unwrap_or(mtime)))
    }
}

/// A hasher that answers the next `hash_at` of a matching path from a
/// script, once per scripted answer, and from disk otherwise.
#[derive(Default)]
pub(crate) struct ScriptedHasher {
    answers: Mutex<Vec<ScriptedAnswer>>,
}

type ScriptedAnswer = (String, Result<String, HashError>);

impl ScriptedHasher {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Answers `answer` for the next call whose path contains
    /// `path_contains`.
    pub(crate) fn answer_once(&self, path_contains: &str, answer: Result<String, HashError>) {
        self.answers
            .lock()
            .unwrap()
            .push((path_contains.to_string(), answer));
    }
}

impl ResourceHasher for ScriptedHasher {
    fn hash_at(&self, path: &str, kind: ResourceKind) -> Result<String, HashError> {
        let mut answers = self.answers.lock().unwrap();
        let found = answers
            .iter()
            .position(|(contains, _)| path.contains(contains.as_str()));
        match found {
            Some(index) => answers.remove(index).1,
            None => {
                drop(answers);
                NativeHasher.hash_at(path, kind)
            }
        }
    }
}

/// A scratch home with the directories a mutation test writes into, a
/// backup root beside them, and the store, fakes and path environment an
/// engine takes.
pub(crate) struct Home {
    pub scratch: crate::test_support::ScratchDir,
    pub home: PathBuf,
    pub backups: PathBuf,
    pub fs: Arc<ScriptedFs>,
    pub hasher: Arc<ScriptedHasher>,
    pub store: super::backup_store::BackupStore,
    pub env: crate::probing::detection::path_env::PathEnv,
}

impl Home {
    pub(crate) fn new(name: &str) -> Self {
        let scratch = crate::test_support::scratch_dir(name);
        let home = scratch.join("home");
        std::fs::create_dir_all(home.join(".claude").join("skills")).unwrap();
        let backups = scratch.join("backups");
        let fs = ScriptedFs::new();
        let counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let store = super::backup_store::BackupStore {
            fs: Arc::clone(&fs) as Arc<dyn MutationFs>,
            root: backups.to_string_lossy().into_owned(),
            platform: crate::health::node_platform().to_string(),
            retention_count: super::backup_store::DEFAULT_RETENTION_COUNT,
            retention_bytes: super::backup_store::DEFAULT_RETENTION_BYTES,
            now_ms: Arc::new(|| 1_758_624_944_087.0),
            random_suffix: Arc::new(move || {
                format!(
                    "{:016x}",
                    counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                )
            }),
        };
        let env = crate::probing::detection::path_env::PathEnv {
            platform: crate::health::node_platform().to_string(),
            home_dir: home.to_string_lossy().into_owned(),
            env: HashMap::new(),
        };
        Self {
            scratch,
            home,
            backups,
            fs,
            hasher: ScriptedHasher::new(),
            store,
            env,
        }
    }

    /// `<home>/<segments...>`.
    pub(crate) fn path(&self, segments: &[&str]) -> PathBuf {
        segments
            .iter()
            .fold(self.home.clone(), |path, segment| path.join(segment))
    }

    /// `<home>/<segments...>` as the string an operation carries.
    pub(crate) fn text(&self, segments: &[&str]) -> String {
        self.path(segments).to_string_lossy().into_owned()
    }

    /// Writes a skill directory with one `SKILL.md` and returns its path.
    pub(crate) fn skill(&self, at: &Path, body: &str) -> PathBuf {
        std::fs::create_dir_all(at).unwrap();
        std::fs::write(
            at.join("SKILL.md"),
            format!("---\nname: gh\ndescription: d\n---\n{body}\n"),
        )
        .unwrap();
        at.to_path_buf()
    }

    /// The digest `hashResourceAt` gives `path`.
    pub(crate) fn hash(&self, path: &Path, kind: ResourceKind) -> String {
        NativeHasher.hash_at(&path.to_string_lossy(), kind).unwrap()
    }

    /// The backup set directory for `backup_id`.
    pub(crate) fn set(&self, backup_id: &str) -> PathBuf {
        self.backups.join(backup_id)
    }

    /// The parsed manifest of `backup_id`.
    pub(crate) fn manifest(&self, backup_id: &str) -> serde_json::Value {
        let text = std::fs::read_to_string(self.set(backup_id).join("manifest.json")).unwrap();
        serde_json::from_str(&text).unwrap()
    }
}
