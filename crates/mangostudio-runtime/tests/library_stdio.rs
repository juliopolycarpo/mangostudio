//! The `library.*` methods through the real compiled binary, spawned as a
//! `stdio` child with a controlled environment — the only way to prove the
//! relocated-home and runtime-local-override behaviour end to end, since
//! both come from the child process's own environment block, and the one
//! place every write-lane answer passes the catalog's own result check.

use std::path::Path;
use std::time::Duration;

use mango_protocol::close::close_codes;
use mango_protocol::session::{Session, SessionClosure, SessionOptions};
use mango_protocol::transports::spawn::{SpawnOptions, sanitized_env, spawn_port};
use serde_json::{Value, json};

mod support;

use support::scratch::{ScratchDir, scratch_path};

const SKILL: &str = "---\nname: SLUG\ndescription: A skill.\n---\nbody\n";

fn write_skill(root: &Path, slug: &str) {
    let dir = root.join(slug);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("SKILL.md"), SKILL.replace("SLUG", slug)).unwrap();
}

/// Spawns `mangostudio-runtime stdio` whose home directory is `home` (both
/// `HOME` and `USERPROFILE`, so every platform's home lookup lands there)
/// plus any `extra` variables of the runtime's own.
async fn spawn_runtime(
    mango_home: &ScratchDir,
    home: &Path,
    extra: &[(&str, &str)],
) -> (Session, tokio::task::JoinHandle<SessionClosure>) {
    let home = home.to_string_lossy().into_owned();
    let mut variables = vec![
        (
            "MANGO_HOME".to_string(),
            mango_home.to_string_lossy().into_owned(),
        ),
        ("HOME".to_string(), home.clone()),
        ("USERPROFILE".to_string(), home),
    ];
    variables.extend(
        extra
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string())),
    );
    let options = SpawnOptions::new([
        env!("CARGO_BIN_EXE_mangostudio-runtime").to_string(),
        "stdio".into(),
    ])
    .with_env(sanitized_env(variables));
    let (port, _launched) = spawn_port(options).expect("the argv names a real binary");
    let (session, driver) = Session::spawn(port, SessionOptions::new(support::peer("hub")));
    let remote = tokio::time::timeout(Duration::from_secs(10), session.ready())
        .await
        .expect("the child says hello within the timeout")
        .expect("the handshake succeeds");
    assert_eq!(
        remote.capabilities["features"]["library"],
        json!(true),
        "expected features.library true with all ten methods under full consent | received {}",
        remote.capabilities["features"]["library"]
    );
    (session, driver)
}

async fn call(session: &Session, method: &str, params: Value) -> Value {
    tokio::time::timeout(Duration::from_secs(20), session.request(method, params))
        .await
        .unwrap_or_else(|_| panic!("{method} answers within the timeout"))
        .unwrap_or_else(|error| panic!("{method} failed: {error:?}"))
}

fn slugs(scan: &Value) -> Vec<String> {
    let mut slugs: Vec<String> = scan["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["ref"]["slug"].as_str().unwrap().to_string())
        .collect();
    slugs.sort();
    slugs
}

#[tokio::test]
async fn a_relocated_home_is_where_the_compiled_runtime_looks() {
    let mango_home = scratch_path("library-stdio-relocated-mango");
    let home = scratch_path("library-stdio-relocated-home");
    std::fs::create_dir_all(&*home).unwrap();
    let skills = home.join(".mango").join("skills");
    write_skill(&skills, "relocated");
    let (session, driver) = spawn_runtime(&mango_home, &home, &[]).await;

    let scan = call(
        &session,
        "library.scan",
        json!({ "locationSettings": { "home": {}, "workspace": {} } }),
    )
    .await;
    assert_eq!(
        slugs(&scan),
        ["relocated"],
        "expected the relocated home's skill | received {scan}"
    );

    let locations = call(&session, "library.locations", json!({})).await;
    let mango_skills = locations["locations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|location| location["id"] == "mango-skills")
        .cloned()
        .unwrap();
    assert_eq!(mango_skills["path"], json!(skills.to_string_lossy()));

    let sources = call(&session, "library.settings-sources", json!({})).await;
    assert_eq!(sources["homeDir"], json!(home.to_string_lossy()));

    let entry = skills.join("relocated").join("SKILL.md");
    let read = call(
        &session,
        "library.read",
        json!({ "path": entry.to_string_lossy(), "locationId": "mango-skills" }),
    )
    .await;
    assert_eq!(read["content"], json!(SKILL.replace("SLUG", "relocated")));

    let tree = call(
        &session,
        "library.read-tree",
        json!({ "path": skills.join("relocated").to_string_lossy(), "locationId": "mango-skills" }),
    )
    .await;
    assert_eq!(tree["files"][0]["relativePath"], json!("SKILL.md"));

    session
        .close(close_codes::RELEASED, Some("test done"))
        .await;
    let _ = driver.await;
}

/// The runtime's own `SKILLS_DIR` is what an unpinned (remote) scan uses; a
/// hub pin applies to its own call only and never leaks into the next.
#[tokio::test]
async fn the_compiled_runtime_keeps_its_own_override_unless_a_call_pins_one() {
    let mango_home = scratch_path("library-stdio-isolation-mango");
    let home = scratch_path("library-stdio-isolation-home");
    std::fs::create_dir_all(&*home).unwrap();
    let runtime_skills = home.join("runtime-skills");
    let hub_skills = home.join("hub-skills");
    write_skill(&runtime_skills, "runtime-own");
    write_skill(&hub_skills, "hub-pinned");
    let runtime_dir = runtime_skills.to_string_lossy().into_owned();
    let (session, driver) =
        spawn_runtime(&mango_home, &home, &[("SKILLS_DIR", &runtime_dir)]).await;

    let unpinned = call(
        &session,
        "library.scan",
        json!({ "locationSettings": { "home": {}, "workspace": {} } }),
    )
    .await;
    assert_eq!(slugs(&unpinned), ["runtime-own"]);
    let pinned = call(
        &session,
        "library.scan",
        json!({ "locationSettings": { "home": {}, "workspace": {} }, "pathEnv": { "env": { "SKILLS_DIR": hub_skills.to_string_lossy() } } }),
    )
    .await;
    assert_eq!(slugs(&pinned), ["hub-pinned"]);
    let again = call(
        &session,
        "library.scan",
        json!({ "locationSettings": { "home": {}, "workspace": {} } }),
    )
    .await;
    assert_eq!(
        slugs(&again),
        ["runtime-own"],
        "the pin must not leak into an unpinned scan"
    );

    session
        .close(close_codes::RELEASED, Some("test done"))
        .await;
    let _ = driver.await;
}

/// Apply (a transferred tree), list, undo, remove, undo the removal, and
/// collect — every write-lane answer validated by the binary's own result
/// check against the catalog, inside a scratch home and backup root.
#[tokio::test]
async fn the_compiled_runtime_applies_removes_undoes_and_collects() {
    use base64::Engine;
    let mango_home = scratch_path("library-stdio-writes-mango");
    let home = scratch_path("library-stdio-writes-home");
    std::fs::create_dir_all(&*home).unwrap();
    let skills = home.join(".mango").join("skills");
    let backups = home.join("backups").to_string_lossy().into_owned();
    write_skill(&skills, "copied");
    let (session, driver) = spawn_runtime(&mango_home, &home, &[]).await;
    let settings = json!({ "home": {}, "workspace": {} });
    let scan = call(
        &session,
        "library.scan",
        json!({ "locationSettings": settings, "force": true }),
    )
    .await;
    let hash = scan["entries"][0]["instance"]["contentHash"].clone();
    std::fs::remove_dir_all(skills.join("copied")).unwrap();

    let body = SKILL.replace("SLUG", "copied");
    let applied = call(
        &session,
        "library.apply",
        json!({
            "backupRoot": backups,
            "environmentId": "stdio-box",
            "operations": [{
                "resourceKey": "skill:copied", "locationId": "mango-skills", "slug": "copied",
                "operation": "create", "kind": "directory", "expectedContentHash": hash,
                "destinationRoot": skills.to_string_lossy(),
                "files": [{ "relativePath": "SKILL.md", "contentRef": "c1" }],
            }],
            "contents": { "c1": base64::engine::general_purpose::STANDARD.encode(&body) },
        }),
    )
    .await;
    assert_eq!(applied["failed"], json!([]), "received {applied}");
    assert_eq!(applied["backups"][0]["environmentId"], "stdio-box");
    let apply_set = applied["backupId"].as_str().unwrap().to_string();
    assert_eq!(
        std::fs::read_to_string(skills.join("copied").join("SKILL.md")).unwrap(),
        body
    );

    let listed = call(
        &session,
        "library.backups",
        json!({ "backupRoot": backups }),
    )
    .await;
    assert_eq!(listed["sets"][0]["backupId"], json!(apply_set));
    assert_eq!(listed["sets"][0]["resourceKeys"], json!(["skill:copied"]));

    let undone = call(
        &session,
        "library.undo",
        json!({ "backupRoot": backups, "backupId": apply_set }),
    )
    .await;
    assert_eq!(
        undone["removed"].as_array().unwrap().len(),
        1,
        "received {undone}"
    );
    assert!(!skills.join("copied").exists());

    write_skill(&skills, "copied");
    let removed = call(
        &session,
        "library.remove",
        json!({
            "backupRoot": backups,
            "operations": [{
                "resourceKey": "skill:copied", "locationId": "mango-skills", "slug": "copied",
                "kind": "directory", "expectedPath": skills.join("copied").to_string_lossy(),
                "expectedContentHash": hash, "lastCopy": true,
            }],
            "lastCopyResourceKeys": ["skill:copied"],
        }),
    )
    .await;
    assert_eq!(removed["failed"], json!([]), "received {removed}");
    let removal_set = removed["backupId"].as_str().unwrap().to_string();
    assert!(!skills.join("copied").exists());
    let listed = call(
        &session,
        "library.backups",
        json!({ "backupRoot": backups, "retentionCount": 1 }),
    )
    .await;
    let pinned = listed["sets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|set| set["backupId"] == json!(removal_set))
        .cloned()
        .unwrap();
    assert_eq!(
        (pinned["pinned"].clone(), pinned["evictsNext"].clone()),
        (json!(true), json!(false))
    );

    let restored = call(
        &session,
        "library.undo",
        json!({ "backupRoot": backups, "backupId": removal_set }),
    )
    .await;
    assert_eq!(
        restored["restored"].as_array().unwrap().len(),
        1,
        "received {restored}"
    );
    assert_eq!(
        std::fs::read_to_string(skills.join("copied").join("SKILL.md")).unwrap(),
        body
    );

    let collected = call(
        &session,
        "library.gc",
        json!({ "backupRoot": backups, "purgeBackupIds": [apply_set, removal_set] }),
    )
    .await;
    assert_eq!(
        collected["purged"].as_array().unwrap().len(),
        2,
        "received {collected}"
    );
    let missing = tokio::time::timeout(
        Duration::from_secs(20),
        session.request(
            "library.undo",
            json!({ "backupRoot": backups, "backupId": removal_set }),
        ),
    )
    .await
    .unwrap()
    .unwrap_err();
    assert_eq!(
        missing
            .details
            .as_ref()
            .and_then(|details| details.get("kind"))
            .cloned(),
        Some(json!("library_backup_missing")),
        "received {missing:?}"
    );

    session
        .close(close_codes::RELEASED, Some("test done"))
        .await;
    let _ = driver.await;
}
