# Portable user-data backup

Stop the Hub (`mangostudio stop`) and stop external editors, runtimes and tools that write
its configured data. Then run:

```sh
mangostudio backup /private/destination/user-data.tar.gz
mangostudio backup /private/destination/user-data.tar.gz --no-checkpoints
```

No restore command is implemented. This version defines archive schema 1 for a later
validated recovery implementation; do not unpack an archive over a running installation.

The command resolves the configured database, uploads, generated images, tool avatars,
agent definitions, skills and checkpoints. Checkpoints are included unless explicitly
omitted. Profile/app settings and user history live in the database. Missing optional roots
are recorded in the manifest. A present unreadable root, unsupported filename, case collision,
symlink (including a configured root itself, even if dangling), multiply linked file or
special file fails the entire capture. All configured roots must be disjoint, including
checkpoints when omitted. The output must be outside those roots and on a filesystem
that supports hard links. Capture refuses existing destinations and paths reserved for
configuration or secrets before staging, even when those managed files are absent.
Fix dangling symlinks along configured paths before capturing. Use explicit directory
paths without `..` components. Collapsing `..` after an
intermediate symlink can select a different directory from the one the application reads.

## Consistency boundary

Hub startup and capture share an exclusive SQLite lock beside the configured database.
The OS releases ownership if either process crashes; never unlink the lock database while
processes might use it. Both the lock and database must be regular files with one link.
A pre-upgrade running Hub is also refused through its state file. On shutdown, the Hub
waits for admitted generation work to settle before releasing ownership. If shutdown
runs out of time, the Hub exits with a failure and the OS releases the lock on exit.
Capture holds a SQLite write reservation while reading committed WAL pages and staging
referenced files. This reservation prevents concurrent database writes; the stopped Hub
prevents the application's media writes. Directory/file identity, size and timestamps are
checked again before publication, and an observed external mutation fails the capture.

External writers must be stopped. This is an offline application-data snapshot, not a
filesystem-wide snapshot or a guarantee against hostile concurrent editors. Remote
workspaces, vendor state, and files outside the named roots are not captured. Environment
metadata does not grant authorization or guarantee that another machine can reconnect.

## Privacy inventory

Raw config.toml, .env, keychains and vendor credential stores are never read into the archive.
The portable config contains only schema/root mappings by default. The private database
snapshot retains user/history, media references, profile/app settings, skill enablement,
todos, checkpoint metadata and tool identities. Environment and MCP names survive as
disabled metadata; launch parameters, environment variables, URLs and transport config
are removed. Provider/tool/agent override payloads are conservatively omitted because they
can carry arbitrary credentials. Account credentials/password hashes, sessions, verification
values, API keys, pairing tokens, secret metadata, provider continuation state, audit/logging,
install state and unrecognized table rows are removed. Redaction and vacuum operate on a
private copy, never the source database. The retained Kysely migration ledger describes its
schema. A restore must validate migration compatibility before using it. Operation
receipts keep their IDs and terminal outcomes so settings references remain valid.
Capture removes private result snapshots and marks accepted or running work unresolved.

The directory walk excludes .env variants, credential/token/secret files by name, private key
formats, SSH identity filenames, .git, node_modules, caches, logs, audit and run directories.
It also excludes resolved managed secret paths and temporary files from atomic secret writes.
All remaining user content is copied verbatim: conversations, uploads, skills and checkpoint
contents may themselves contain secrets. This policy excludes application-managed credentials;
it cannot classify secrets embedded in arbitrary user-authored text or binary files. Inspect
and protect the archive accordingly.

```sh
mangostudio backup /private/destination/user-data.tar.gz --include-secrets
```

This opt-in warns and includes **only the resolved Hub auth secret**, named `hub-auth-secret`
in the manifest. It never exports OS keychain, connector or vendor-managed credentials.
Reauthorization is required after recovery. No broad credential-store export is supported.

## Format, limits and outcomes

A gzip tar contains regular members `manifest.json`, `database.sqlite`, `config.json`, and
files under named root IDs. The schema-first manifest records version, timestamp,
application version, consistency mode, configured source roots/presence, exclusions,
checkpoint/secret decisions and every data member's SHA-256 and byte count. Hashes identify
corruption, not trust. A future restore must validate all paths, types and limits before writes.

Capture permits 10,000 scanned entries, 10,000 data members, 32 MiB per file (including the
database), 128 MiB total expanded data, 140 MiB compressed output and depth 32. Compression
is fixed to gzip level 6; input bounds also bound expansion and memory use. It refuses
Windows-reserved names, forbidden characters, trailing dots/spaces and case/Unicode collisions.
Staging is adjacent to the destination, private (0700 directory / 0600 files on POSIX),
and cleaned up after capture. On Windows, the current user SID is resolved
with whoami and icacls removes inherited grants and grants that user full access before
any data is staged. Failure to establish this ACL refuses capture. Choose a private destination
directory as well. Archive size, permissions and flush operate on one opened descriptor;
on systems supporting O_NOFOLLOW, a substituted final symlink is refused. The final hard
link still names a file within owner-private staging. This protects against replacement by
other unprivileged accounts, not a hostile process already running as the same user.
Cancellation is checked between bounded operations;
a single SQLite/compression operation finishes before cancellation is observed.

The archive is flushed and published through an exclusive atomic hard link, so success
never names a partly written file. Failures and cancellation before publication leave no
output. Once the link succeeds, cancellation leaves the complete archive in place and
any cleanup failure is reported as a warning. A crash or cleanup failure can leave private
`.mango-backup-*` staging. Remove it after confirming the process stopped. A crash after
publication can leave a complete archive without a success message. Verify its manifest
and member hashes before relying on it.
