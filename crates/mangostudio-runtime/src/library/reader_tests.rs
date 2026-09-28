//! The bounded walk and the hash pass behind it: streamed listings stop at
//! the existing caps, and the canonical-path lookups stay constant time.
//!
//! [`MemFs`] is a strict in-memory [`LibraryFs`]: an unknown path is
//! `NotFound`, a listing is produced lazily and counts every entry it
//! yields, and symlinks resolve component by component like `realpath`.
//! Its paths are Unix-shaped, so the tests that use it are `cfg(unix)`; the
//! path-identity and operation-count tests below run everywhere.

use std::cell::Cell;
use std::collections::HashSet;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

use tokio_util::sync::CancellationToken;

use super::*;
use crate::library::collation::locale_compare;

#[cfg(unix)]
mod memory_fs {
    use std::collections::HashMap;
    use std::ffi::OsString;
    use std::io::{Error, ErrorKind};
    use std::path::{Component, Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};

    use tokio_util::sync::CancellationToken;

    use crate::library::fs::{DirEntries, FileMeta, LibraryFs, ReadFailure};

    /// One node of the fake tree.
    #[derive(Clone)]
    pub(super) enum Node {
        Dir(Vec<String>),
        File(Vec<u8>),
        /// A regular file that reports `size` without holding its bytes.
        Sized(u64),
        Link(PathBuf),
        /// A directory of `count` files `f0..f{count-1}`, never materialised.
        Generated {
            count: usize,
            size: u64,
        },
    }

    #[derive(Default)]
    pub(super) struct MemFs {
        nodes: HashMap<PathBuf, Node>,
        unlistable: Vec<PathBuf>,
        /// Directory -> index at which the listing fails instead of yielding.
        fail_listing_at: HashMap<PathBuf, usize>,
        /// Cancels once this many entries were yielded across all listings.
        cancel_after: Option<(usize, CancellationToken)>,
        /// Entries yielded by every listing so far.
        pub(super) pulled: AtomicUsize,
        pub(super) real_paths: AtomicUsize,
    }

    impl MemFs {
        pub(super) fn with(mut self, path: &str, node: Node) -> Self {
            self.nodes.insert(PathBuf::from(path), node);
            self
        }

        pub(super) fn dir(self, path: &str, names: &[&str]) -> Self {
            let names = names.iter().map(ToString::to_string).collect();
            self.with(path, Node::Dir(names))
        }

        pub(super) fn file(self, path: &str, bytes: &[u8]) -> Self {
            self.with(path, Node::File(bytes.to_vec()))
        }

        pub(super) fn link(self, path: &str, target: &str) -> Self {
            self.with(path, Node::Link(PathBuf::from(target)))
        }

        pub(super) fn unlistable(mut self, path: &str) -> Self {
            self.unlistable.push(PathBuf::from(path));
            self
        }

        pub(super) fn failing_at(mut self, path: &str, index: usize) -> Self {
            self.fail_listing_at.insert(PathBuf::from(path), index);
            self
        }

        pub(super) fn cancelling_after(
            mut self,
            pulled: usize,
            cancel: &CancellationToken,
        ) -> Self {
            self.cancel_after = Some((pulled, cancel.clone()));
            self
        }

        pub(super) fn pulled(&self) -> usize {
            self.pulled.load(Ordering::SeqCst)
        }

        fn node_at(&self, canonical: &Path) -> Option<Node> {
            if let Some(node) = self.nodes.get(canonical) {
                return Some(node.clone());
            }
            let parent = canonical.parent()?;
            let Some(Node::Generated { count, size }) = self.nodes.get(parent) else {
                return None;
            };
            let index: usize = canonical
                .file_name()?
                .to_str()?
                .strip_prefix('f')?
                .parse()
                .ok()?;
            (index < *count).then_some(Node::Sized(*size))
        }

        /// `realpath`: links resolve wherever they sit in the path.
        fn resolve(&self, path: &Path) -> std::io::Result<(PathBuf, Node)> {
            let mut current = PathBuf::new();
            let mut hops = 0;
            for component in path.components() {
                match component {
                    Component::RootDir => current.push("/"),
                    Component::Normal(part) => current.push(part),
                    other => panic!("MemFs paths are absolute and normal | received {other:?}"),
                }
                while let Some(Node::Link(target)) = self.node_at(&current) {
                    hops += 1;
                    if hops > 40 {
                        return Err(Error::other("too many levels of symbolic links"));
                    }
                    current = self.resolve(&target)?.0;
                }
            }
            match self.node_at(&current) {
                Some(node) => Ok((current, node)),
                None => Err(Error::new(
                    ErrorKind::NotFound,
                    format!("MemFs has no node at {}", path.display()),
                )),
            }
        }
    }

    struct Entries<'a> {
        fs: &'a MemFs,
        names: std::vec::IntoIter<String>,
        remaining_generated: std::ops::Range<usize>,
        index: usize,
        fail_at: Option<usize>,
    }

    impl Iterator for Entries<'_> {
        type Item = std::io::Result<OsString>;

        fn next(&mut self) -> Option<Self::Item> {
            if self.fail_at == Some(self.index) {
                self.fail_at = None;
                return Some(Err(Error::other(format!(
                    "listing failed at entry {}",
                    self.index
                ))));
            }
            let name = self
                .names
                .next()
                .or_else(|| self.remaining_generated.next().map(|i| format!("f{i}")))?;
            self.index += 1;
            let pulled = self.fs.pulled.fetch_add(1, Ordering::SeqCst) + 1;
            if let Some((limit, cancel)) = &self.fs.cancel_after
                && pulled >= *limit
            {
                cancel.cancel();
            }
            Some(Ok(OsString::from(name)))
        }
    }

    impl LibraryFs for MemFs {
        fn read_dir<'a>(&'a self, path: &Path) -> std::io::Result<DirEntries<'a>> {
            let (canonical, node) = self.resolve(path)?;
            if self.unlistable.contains(&canonical) {
                return Err(Error::new(
                    ErrorKind::PermissionDenied,
                    format!("MemFs refuses to list {}", canonical.display()),
                ));
            }
            let (names, generated) = match node {
                Node::Dir(names) => (names, 0),
                Node::Generated { count, .. } => (Vec::new(), count),
                _ => {
                    return Err(Error::other(format!(
                        "MemFs: {} is not a directory",
                        path.display()
                    )));
                }
            };
            Ok(Box::new(Entries {
                fs: self,
                names: names.into_iter(),
                remaining_generated: 0..generated,
                index: 0,
                fail_at: self.fail_listing_at.get(&canonical).copied(),
            }))
        }

        fn real_path(&self, path: &Path) -> std::io::Result<PathBuf> {
            self.real_paths.fetch_add(1, Ordering::SeqCst);
            Ok(self.resolve(path)?.0)
        }

        fn stat(&self, path: &Path) -> std::io::Result<FileMeta> {
            let (_, node) = self.resolve(path)?;
            let size = match &node {
                Node::File(bytes) => bytes.len() as u64,
                Node::Sized(size) => *size,
                _ => 0,
            };
            Ok(FileMeta {
                size,
                mtime_ms: 0.0,
                is_file: matches!(node, Node::File(_) | Node::Sized(_)),
                is_dir: matches!(node, Node::Dir(_) | Node::Generated { .. }),
            })
        }

        fn read_file(
            &self,
            _root: Option<&Path>,
            path: &Path,
            max_bytes: u64,
        ) -> Result<Vec<u8>, ReadFailure> {
            let (_, node) = self
                .resolve(path)
                .map_err(|error| ReadFailure::Unreadable(error.to_string()))?;
            match node {
                Node::File(bytes) if bytes.len() as u64 <= max_bytes => Ok(bytes),
                Node::File(_) => Err(ReadFailure::TooLarge),
                _ => Err(ReadFailure::Unreadable(format!(
                    "MemFs: {} holds no bytes",
                    path.display()
                ))),
            }
        }
    }
}

#[cfg(unix)]
use memory_fs::{MemFs, Node};

#[cfg(unix)]
fn walk(fs: &MemFs, cancel: &CancellationToken) -> Result<Vec<Leaf>, WalkError> {
    collect_leaf_files(fs, Path::new("/r"), cancel)
}

#[cfg(unix)]
fn walk_uncancelled(fs: &MemFs) -> Result<Vec<Leaf>, WalkError> {
    walk(fs, &CancellationToken::new())
}

#[cfg(unix)]
fn relatives(leaves: &[Leaf]) -> Vec<&str> {
    leaves.iter().map(|leaf| leaf.relative.as_str()).collect()
}

#[cfg(unix)]
mod streamed_walk {
    use super::*;

    #[test]
    fn a_listing_over_the_entry_cap_stops_after_cap_plus_one_entries() {
        let listed = MAX_LIBRARY_INSTANCE_ENTRIES * 5;
        let fs = MemFs::default().with(
            "/r",
            Node::Generated {
                count: listed,
                size: 0,
            },
        );
        let outcome = walk_uncancelled(&fs).map(|leaves| leaves.len());
        let pulled = fs.pulled();
        assert_eq!(
            (&outcome, pulled),
            (&Err(WalkError::TooLarge), MAX_LIBRARY_INSTANCE_ENTRIES + 1),
            "expected TooLarge after pulling {} of {listed} listed entries | received {outcome:?} after {pulled} pulled",
            MAX_LIBRARY_INSTANCE_ENTRIES + 1
        );
    }

    #[test]
    fn exactly_the_entry_cap_of_leaves_is_accepted_and_sorted() {
        let fs = MemFs::default().with(
            "/r",
            Node::Generated {
                count: MAX_LIBRARY_INSTANCE_ENTRIES,
                size: 0,
            },
        );
        let leaves = walk_uncancelled(&fs).expect("cap leaves are within the cap");
        assert_eq!(leaves.len(), MAX_LIBRARY_INSTANCE_ENTRIES);
        let sorted = leaves
            .windows(2)
            .all(|pair| locale_compare(&pair[0].relative, &pair[1].relative).is_le());
        assert!(sorted, "expected leaves sorted by locale_compare");
        assert_eq!(fs.pulled(), MAX_LIBRARY_INSTANCE_ENTRIES);
    }

    #[test]
    fn the_byte_cap_stops_the_listing_at_the_entry_that_crosses_it() {
        let two_mib = 2 * 1024 * 1024;
        let fs = MemFs::default().with(
            "/r",
            Node::Generated {
                count: 1_000,
                size: two_mib,
            },
        );
        assert_eq!(walk_uncancelled(&fs), Err(WalkError::TooLarge));
        let fitting = MAX_LIBRARY_INSTANCE_BYTES / two_mib;
        assert_eq!(
            fs.pulled() as u64,
            fitting + 1,
            "expected the walk to stop at the first entry past {MAX_LIBRARY_INSTANCE_BYTES} bytes"
        );
    }

    #[test]
    fn the_byte_cap_boundary_is_inclusive() {
        let half = MAX_LIBRARY_INSTANCE_BYTES / 2;
        let at_cap = MemFs::default()
            .dir("/r", &["a", "b"])
            .with("/r/a", Node::Sized(half))
            .with("/r/b", Node::Sized(half));
        let over = MemFs::default()
            .dir("/r", &["a", "b"])
            .with("/r/a", Node::Sized(half))
            .with("/r/b", Node::Sized(half + 1));
        assert_eq!(walk_uncancelled(&at_cap).map(|leaves| leaves.len()), Ok(2));
        assert_eq!(walk_uncancelled(&over), Err(WalkError::TooLarge));
    }

    fn chain(depth: usize) -> MemFs {
        let mut fs = MemFs::default();
        let mut path = String::from("/r");
        for _ in 0..depth {
            fs = fs.dir(&path, &["d"]);
            path.push_str("/d");
        }
        fs.dir(&path, &["leaf"]).file(&format!("{path}/leaf"), b"x")
    }

    #[test]
    fn the_depth_cap_boundary_is_inclusive() {
        let deepest_allowed = walk_uncancelled(&chain(MAX_LIBRARY_INSTANCE_DEPTH));
        let one_deeper = walk_uncancelled(&chain(MAX_LIBRARY_INSTANCE_DEPTH + 1));
        assert_eq!(
            deepest_allowed.map(|leaves| leaves.len()),
            Ok(1),
            "expected a chain {MAX_LIBRARY_INSTANCE_DEPTH} directories deep to walk"
        );
        assert_eq!(one_deeper, Err(WalkError::TooLarge));
    }

    #[test]
    fn leaves_come_back_sorted_whatever_order_the_listing_used() {
        let fs = MemFs::default()
            .dir("/r", &["Z.md", "é.md", "B.md", "sub", "a.md"])
            .dir("/r/sub", &["y.md", "x.md"])
            .file("/r/Z.md", b"z")
            .file("/r/é.md", b"e")
            .file("/r/B.md", b"b")
            .file("/r/a.md", b"a")
            .file("/r/sub/y.md", b"y")
            .file("/r/sub/x.md", b"x");
        let leaves = walk_uncancelled(&fs).unwrap();
        assert_eq!(
            relatives(&leaves),
            ["a.md", "B.md", "é.md", "sub/x.md", "sub/y.md", "Z.md"]
        );
    }

    #[test]
    fn a_directory_reached_twice_is_a_path_escape() {
        let cycle = MemFs::default()
            .dir("/r", &["a"])
            .dir("/r/a", &["loop", "f"])
            .link("/r/a/loop", "/r/a")
            .file("/r/a/f", b"x");
        let duplicate = MemFs::default()
            .dir("/r", &["one", "two"])
            .dir("/r/one", &[])
            .link("/r/two", "/r/one");
        let outside = MemFs::default()
            .dir("/r", &["out"])
            .link("/r/out", "/elsewhere")
            .dir("/elsewhere", &[]);
        assert_eq!(walk_uncancelled(&cycle), Err(WalkError::PathEscape));
        assert_eq!(walk_uncancelled(&duplicate), Err(WalkError::PathEscape));
        assert_eq!(walk_uncancelled(&outside), Err(WalkError::PathEscape));
    }

    #[test]
    fn an_unlistable_directory_is_unreadable_at_any_depth() {
        let root = MemFs::default().dir("/r", &[]).unlistable("/r");
        let nested = MemFs::default()
            .dir("/r", &["a", "b"])
            .dir("/r/a", &[])
            .dir("/r/b", &[])
            .unlistable("/r/b");
        for (label, fs) in [("root", root), ("nested", nested)] {
            let outcome = walk_uncancelled(&fs);
            assert!(
                matches!(&outcome, Err(WalkError::Unreadable(message)) if message.contains("refuses to list")),
                "{label}: expected Unreadable naming the refused listing | received {outcome:?}"
            );
        }
    }

    #[test]
    fn a_listing_that_fails_part_way_is_unreadable_not_a_short_success() {
        let fs = MemFs::default()
            .dir("/r", &["a", "b", "c"])
            .file("/r/a", b"a")
            .file("/r/b", b"b")
            .file("/r/c", b"c")
            .failing_at("/r", 2);
        let outcome = walk_uncancelled(&fs);
        assert_eq!(
            outcome,
            Err(WalkError::Unreadable(
                "listing failed at entry 2".to_string()
            )),
            "expected the failed listing to fail the whole walk | received {outcome:?}"
        );
    }

    #[test]
    fn cancelling_mid_listing_stops_the_pull() {
        let cancel = CancellationToken::new();
        let fs = MemFs::default()
            .with(
                "/r",
                Node::Generated {
                    count: 1_000,
                    size: 0,
                },
            )
            .cancelling_after(3, &cancel);
        assert_eq!(walk(&fs, &cancel), Err(WalkError::Cancelled));
        assert_eq!(
            fs.pulled(),
            3,
            "expected no entry to be pulled after the cancel"
        );
    }

    #[test]
    fn a_walk_cancelled_up_front_lists_nothing() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        let fs = MemFs::default().dir("/r", &["a"]).file("/r/a", b"a");
        assert_eq!(walk(&fs, &cancel), Err(WalkError::Cancelled));
        assert_eq!(fs.pulled(), 0);
    }
}

#[cfg(unix)]
mod location_scan {
    use std::sync::Mutex;

    use super::*;
    use crate::library::cache::LibraryCache;
    use crate::library::hash::{combine_whitespace_digests, whitespace_digest};
    use crate::library::types::ScanResult;
    use crate::probing::locations::location_by_id;

    fn scan(fs: &MemFs, warnings: &Mutex<Vec<String>>) -> ScanResult {
        let location = location_by_id("mango-skills").expect("mango-skills is registered");
        let cache = LibraryCache::default();
        let cancel = CancellationToken::new();
        let warn = |message: &str| warnings.lock().unwrap().push(message.to_string());
        let context = ScanContext {
            cache: &cache,
            force: true,
            fs,
            platform: "linux",
            cancel: &cancel,
            warn: &warn,
        };
        read_location_instances(location, "/lib/skills", &context).expect("the scan completes")
    }

    #[test]
    fn a_location_listing_that_fails_part_way_is_skipped_with_a_diagnostic() {
        let fs = MemFs::default()
            .dir("/lib/skills", &["alpha", "beta"])
            .dir("/lib/skills/alpha", &["SKILL.md"])
            .file("/lib/skills/alpha/SKILL.md", b"---\nname: alpha\n---\n")
            .failing_at("/lib/skills", 1);
        let warnings = Mutex::new(Vec::new());
        let scanned = scan(&fs, &warnings);
        assert_eq!(
            (scanned.entries.len(), warnings.lock().unwrap().len()),
            (0, 1),
            "expected an empty result and one diagnostic | received {scanned:?}"
        );
    }

    #[test]
    fn leaves_that_alias_one_file_each_record_every_name_in_the_whitespace_hash() {
        let body = b"---\nname: alpha\ndescription: An alpha skill\n---\nbody\n";
        let fs = MemFs::default()
            .dir("/lib/skills", &["alpha"])
            .dir("/lib/skills/alpha", &["SKILL.md", "alias.md", "other.md"])
            .file("/lib/skills/alpha/SKILL.md", body)
            .link("/lib/skills/alpha/alias.md", "/lib/skills/alpha/SKILL.md")
            .file("/lib/skills/alpha/other.md", b"other\n");
        let warnings = Mutex::new(Vec::new());
        let scanned = scan(&fs, &warnings);
        let digest = whitespace_digest(body);
        let other = whitespace_digest(b"other\n");
        let twice = |name: &str| (name.to_string(), digest.clone());
        let expected = combine_whitespace_digests(&[
            twice("alias.md"),
            twice("SKILL.md"),
            ("other.md".to_string(), other),
            twice("alias.md"),
            twice("SKILL.md"),
        ]);
        let entry = scanned.entries.first().expect("one instance");
        assert_eq!(
            entry.whitespace_hash.as_deref(),
            Some(expected.as_str()),
            "expected each alias name recorded once per read of the shared file"
        );
        assert!(entry.instance.valid, "received {:?}", entry.instance);
    }
}

thread_local! {
    static EQ_CALLS: Cell<usize> = const { Cell::new(0) };
}

/// A key whose every `==` is counted on this thread, so a lookup's cost is
/// measured in comparisons rather than wall time.
#[derive(Clone, Debug)]
struct CountedKey(PathBuf);

impl PartialEq for CountedKey {
    fn eq(&self, other: &Self) -> bool {
        EQ_CALLS.with(|calls| calls.set(calls.get() + 1));
        self.0 == other.0
    }
}

impl Eq for CountedKey {}

impl Hash for CountedKey {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.0.hash(state);
    }
}

fn counted(index: usize) -> CountedKey {
    CountedKey(PathBuf::from(format!("/canonical/dir-{index}")))
}

fn eq_calls_during(work: impl FnOnce()) -> usize {
    EQ_CALLS.with(|calls| calls.set(0));
    work();
    EQ_CALLS.with(Cell::get)
}

const MANY: usize = 2_000;

#[test]
fn visited_directories_are_found_without_comparing_against_every_earlier_one() {
    let mut visited = VisitedDirs::default();
    let calls = eq_calls_during(|| {
        for index in 0..MANY {
            assert!(visited.first_visit(counted(index)));
        }
        for index in 0..MANY {
            assert!(
                !visited.first_visit(counted(index)),
                "dir-{index} is a repeat"
            );
        }
    });
    assert!(
        calls <= 4 * MANY,
        "expected at most {} path comparisons for {MANY} directories visited twice | received {calls}",
        4 * MANY
    );
}

#[test]
fn alias_lookups_do_not_compare_against_every_known_file() {
    let mut aliases = AliasIndex::default();
    let calls = eq_calls_during(|| {
        for index in 0..MANY {
            aliases.add(counted(index), &format!("leaf-{index}.md"));
        }
        for index in 0..MANY {
            assert_eq!(aliases.names(&counted(index)), [format!("leaf-{index}.md")]);
        }
    });
    assert!(
        calls <= 4 * MANY,
        "expected at most {} path comparisons for {MANY} aliased files | received {calls}",
        4 * MANY
    );
}

#[test]
fn an_alias_keeps_its_names_in_leaf_order_and_unknown_files_have_none() {
    let mut aliases = AliasIndex::default();
    for (canonical, name) in [("/a", "z"), ("/b", "m"), ("/a", "a"), ("/a", "m")] {
        aliases.add(PathBuf::from(canonical), name);
    }
    assert_eq!(aliases.names(&PathBuf::from("/a")), ["z", "a", "m"]);
    assert_eq!(aliases.names(&PathBuf::from("/b")), ["m"]);
    assert!(aliases.names(&PathBuf::from("/c")).is_empty());
}

/// The set answers exactly as the `Vec::contains` it replaced, because
/// `PathBuf` hashes the way it compares: component-wise, so separators and
/// `.` normalise, while case never folds (on Windows either).
#[test]
fn visited_membership_matches_a_linear_scan_over_tricky_paths() {
    let arrivals = [
        "/r/Skill",
        "/r/skill",
        "/r/skill/",
        "/r//skill",
        "/r/./skill",
        "/r/é",
        "/r/e\u{301}",
        "/r/skill/sub",
        "/r/Skill",
    ];
    let mut reference: Vec<PathBuf> = Vec::new();
    let mut visited = VisitedDirs::default();
    for arrival in arrivals {
        let path = PathBuf::from(arrival);
        let expected_first = !reference.contains(&path);
        if expected_first {
            reference.push(path.clone());
        }
        assert_eq!(
            visited.first_visit(path),
            expected_first,
            "expected {arrival} to be {} | linear scan disagreed",
            if expected_first { "new" } else { "a repeat" }
        );
    }
    assert_eq!(reference.len(), 5, "case and Unicode forms stay distinct");
    let distinct: HashSet<_> = reference.iter().collect();
    assert_eq!(distinct.len(), reference.len());
}
