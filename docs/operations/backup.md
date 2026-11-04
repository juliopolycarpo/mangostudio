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
symlink (including a configured root itself, even if dangling) or special file fails the entire capture. The output must be outside the source
roots, on a filesystem supporting hard links; existing destinations are never replaced.

## Consistency boundary

Hub startup and capture share an exclusive SQLite lock beside the configured database.
The OS releases ownership if either process crashes; never unlink the lock database while
processes might use it. A pre-upgrade running Hub is also refused through its state file.
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
schema; restore must validate migration compatibility before using it.

The directory walk excludes .env variants, credential/token/secret files by name, private key
formats, SSH identity filenames, .git, node_modules, caches, logs, audit and run directories.
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
and removed on success, cancellation or failure. On Windows, the current user SID is resolved
with whoami and icacls removes inherited grants and grants that user full access before
any data is staged. Failure to establish this ACL refuses capture. Choose a private destination
directory as well. Cancellation is checked between bounded operations;
a single SQLite/compression operation finishes before cancellation is observed.

The archive is flushed and published through an exclusive atomic hard link, so success
never names a partly written file. A failed or canceled capture reports an error and removes
its temporary files; no partial success is returned. A crash can leave private
`.mango-backup-*` staging, which an operator may remove after confirming the process stopped.
A crash after publication can leave a complete archive without a success message; validate
its manifest rather than assuming it failed. Source data and pre-existing output remain intact.

Native macOS/Windows execution, full-suite CI and recovery round trips remain required
qualification before declaring the backup/restore plan complete.
