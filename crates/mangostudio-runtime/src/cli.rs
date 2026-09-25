//! Argument parsing and dispatch for the `mangostudio-runtime` binary.
//!
//! Mirrors the commands in `apps/runtime/src/cli.ts`: setup, native
//! installation, health, doctor, audit, user service management, and the
//! three transports in [`crate::transport`].
//!
//! Every synchronous, disk-touching decision (consent, token resolution,
//! resolving and remembering a listen address or hub URL) happens here,
//! before a Tokio runtime is ever built — never inside one, which is what
//! keeps every `std::fs` call in this module off a Tokio executor thread
//! without a single `spawn_blocking`. Only the transport itself
//! ([`crate::transport::stdio::run`], [`crate::transport::serve::run`],
//! [`crate::transport::connect::run`]) runs inside the runtime this module
//! builds for it.

use std::io::BufRead as _;
use std::net::{SocketAddr, ToSocketAddrs};
use std::path::PathBuf;

use mangostudio_runtime_contract::manifest::ManifestProfile;
use tokio_util::sync::CancellationToken;

use crate::config::{EnvSource, RuntimeConfig};
use crate::consent::invocation::{consent_by_invocation, setup_command};
use crate::ports::wall_clock::SystemWallClock;
use crate::runtime_home::{
    RuntimeSlot, SlotFileError, read_runtime_slot_config, resolve_runtime_slot_for_current_exe,
    write_runtime_slot_config,
};
use crate::setup::{self, NonInteractiveSetupRequest, parse_allow_overrides};
use crate::transport::connect::RandomJitter;

#[path = "cli/native_operation.rs"]
mod native_operation;

/// The release this binary reports: `--version`, the handshake's peer
/// version, and every health payload.
///
/// `scripts/build.ts` stamps the distribution's release version in at compile
/// time through `MANGOSTUDIO_RELEASE_VERSION`, because a canary or dry-run
/// build carries a version (`0.0.0-dryrun`, `<x>-canary.<sha>`) the committed
/// manifest never does, and the hub refuses a sibling runtime whose release
/// differs from its own. A plain `cargo build` falls back to the manifest
/// version, which `bun run check:versions` keeps in lockstep with the app.
/// This is a compile-time stamp, not host configuration: nothing reads it
/// from the process environment at run time.
const VERSION: &str = match option_env!("MANGOSTUDIO_RELEASE_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};

const USAGE: &str = "mangostudio-runtime {VERSION}\n\
\n\
Usage: mangostudio-runtime <command> [options]\n\
\n\
Commands:\n\
\x20\x20setup [--profile <full|readonly|none>] [--slot <host|wsl|remote>] [--allow k=v,...] [--audit on|off] [--yes] [--json]\n\
\x20\x20install [--slot <host|wsl|remote>] [--json]\n\
\x20\x20health|doctor [--json]\n\
\x20\x20service <install|uninstall|status|start|stop|restart> [--mode connect|serve] [--force] [--json]\n\
\x20\x20audit [--slot <host|wsl|remote>] [--since <when>] [--denied] [--json]\n\
\x20\x20stdio (or --stdio)\n\
\x20\x20serve --listen <port|host:port> [--token -|env]\n\
\x20\x20connect --hub <url> [--token -|env]\n\
\n\
Options:\n\
\x20\x20-v, --version  Print the version and exit\n\
\x20\x20-h, --help     Print this message and exit";

/// One parsed invocation.
enum Invocation {
    Version,
    Help,
    Setup(SetupArgs),
    Install(InstallArgs),
    Health { json: bool },
    Doctor { json: bool },
    Service(ServiceArgs),
    Audit(AuditArgs),
    Stdio,
    Serve(ServeArgs),
    Connect(ConnectArgs),
    Unknown(String),
    Invalid(String),
    Empty,
}

struct SetupArgs {
    slot: Option<RuntimeSlot>,
    profile: Option<ManifestProfile>,
    allow: Vec<(String, bool)>,
    audit: Option<bool>,
    yes: bool,
    json: bool,
}

struct InstallArgs {
    slot: RuntimeSlot,
    json: bool,
}

struct ServiceArgs {
    action: ServiceAction,
    mode: Option<ServiceMode>,
    json: bool,
    force: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ServiceAction {
    Install,
    Uninstall,
    Status,
    Start,
    Stop,
    Restart,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ServiceMode {
    Connect,
    Serve,
}

#[cfg(any(unix, windows))]
impl ServiceMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Connect => "connect",
            Self::Serve => "serve",
        }
    }
}

struct AuditArgs {
    slot: Option<RuntimeSlot>,
    since: Option<String>,
    denied: bool,
    json: bool,
}

struct ServeArgs {
    listen: Option<String>,
    token_source: TokenSource,
}

struct ConnectArgs {
    hub: Option<String>,
    token_source: TokenSource,
}

/// Where `serve`/`connect` should read their credential from, mirroring
/// `cli.ts`'s `RuntimeConnectArgs['tokenSource']`. Never a bare CLI flag
/// value — see [`RuntimeConfig`]'s own doc comment for why argv is the one
/// place a token must not appear.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum TokenSource {
    /// Read one line from stdin.
    Stdin,
    /// `MANGOSTUDIO_RUNTIME_TOKEN`/`MANGOSTUDIO_RUNTIME_SERVE_TOKEN` only —
    /// never falls back to a stored credential.
    Env,
    /// The environment, then a previously stored credential. The default.
    #[default]
    EnvOrStored,
}

fn parse_token_source(value: &str) -> Option<TokenSource> {
    match value {
        // `-` is what `cli.ts` actually accepts, and what the pairing card
        // in `RuntimePairingPanel.tsx` prints (`--token -`) — `stdin` is
        // this crate's own invention, kept as an accepted alias rather
        // than dropped, since it is a clearer word for the same thing.
        "-" | "stdin" => Some(TokenSource::Stdin),
        "env" => Some(TokenSource::Env),
        _ => None,
    }
}

fn parse_slot(value: &str) -> Option<RuntimeSlot> {
    value.parse().ok()
}

fn parse(args: &[String]) -> Invocation {
    let Some(first) = args.first() else {
        return Invocation::Empty;
    };
    match first.as_str() {
        "--version" | "-v" => Invocation::Version,
        "--help" | "-h" => Invocation::Help,
        "setup" => parse_setup(&args[1..]),
        "install" => parse_install(&args[1..]),
        "health" => parse_report(&args[1..], false),
        "doctor" => parse_report(&args[1..], true),
        "service" => parse_service(&args[1..]),
        "audit" => parse_audit(&args[1..]),
        // Both spellings are accepted: `spawnRuntimeChild` always appends
        // `--stdio` (`[launch.command, ...launch.args, '--stdio']`), so a
        // hub launching this binary never sends the bare word at all —
        // without this, no production stdio launch reaches this binary.
        "--stdio" | "stdio" => {
            if args.len() > 1 {
                return Invocation::Unknown(args[1].clone());
            }
            Invocation::Stdio
        }
        "serve" => parse_serve(&args[1..]),
        "connect" => parse_connect(&args[1..]),
        other => Invocation::Unknown(other.to_string()),
    }
}

fn parse_install(args: &[String]) -> Invocation {
    let mut slot = RuntimeSlot::Remote;
    let mut json = false;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--slot" => {
                let Some(value) = args.get(index + 1) else {
                    return Invocation::Invalid("--slot needs host, wsl, or remote.".into());
                };
                let Some(parsed) = parse_slot(value) else {
                    return Invocation::Invalid(format!(
                        "--slot takes host, wsl, or remote, not {value:?}."
                    ));
                };
                slot = parsed;
                index += 2;
            }
            "--json" => {
                json = true;
                index += 1;
            }
            other => return Invocation::Unknown(other.into()),
        }
    }
    Invocation::Install(InstallArgs { slot, json })
}

fn parse_report(args: &[String], doctor: bool) -> Invocation {
    let mut json = false;
    for arg in args {
        if arg != "--json" {
            return Invocation::Unknown(arg.clone());
        }
        json = true;
    }
    if doctor {
        Invocation::Doctor { json }
    } else {
        Invocation::Health { json }
    }
}

fn parse_service(args: &[String]) -> Invocation {
    let Some(action) = args.first() else {
        return Invocation::Invalid(
            "service needs install, uninstall, status, start, stop, or restart.".into(),
        );
    };
    let action = match action.as_str() {
        "install" => ServiceAction::Install,
        "uninstall" => ServiceAction::Uninstall,
        "status" => ServiceAction::Status,
        "start" => ServiceAction::Start,
        "stop" => ServiceAction::Stop,
        "restart" => ServiceAction::Restart,
        other => return Invocation::Unknown(other.into()),
    };
    let mut mode = None;
    let mut json = false;
    let mut force = false;
    let mut index = 1;
    while index < args.len() {
        match args[index].as_str() {
            "--mode" => {
                let Some(value) = args.get(index + 1) else {
                    return Invocation::Invalid("--mode needs connect or serve.".into());
                };
                mode = match value.as_str() {
                    "connect" => Some(ServiceMode::Connect),
                    "serve" => Some(ServiceMode::Serve),
                    _ => {
                        return Invocation::Invalid(format!(
                            "--mode takes connect or serve, not {value:?}."
                        ));
                    }
                };
                index += 2;
            }
            "--json" => {
                json = true;
                index += 1;
            }
            "--force" if action == ServiceAction::Stop => {
                force = true;
                index += 1;
            }
            other => return Invocation::Unknown(other.into()),
        }
    }
    Invocation::Service(ServiceArgs {
        action,
        mode,
        json,
        force,
    })
}

fn parse_audit(args: &[String]) -> Invocation {
    let mut slot = None;
    let mut since = None;
    let mut denied = false;
    let mut json = false;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--slot" => {
                let Some(value) = args.get(index + 1) else {
                    return Invocation::Invalid("--slot needs host, wsl, or remote.".into());
                };
                slot = match parse_slot(value) {
                    Some(slot) => Some(slot),
                    None => {
                        return Invocation::Invalid(format!(
                            "--slot takes host, wsl, or remote, not {value:?}."
                        ));
                    }
                };
                index += 2;
            }
            "--since" => {
                let Some(value) = args.get(index + 1) else {
                    return Invocation::Invalid(
                        "--since needs an ISO-8601 instant or relative duration like 24h.".into(),
                    );
                };
                since = Some(value.clone());
                index += 2;
            }
            "--denied" => {
                denied = true;
                index += 1;
            }
            "--json" => {
                json = true;
                index += 1;
            }
            other => return Invocation::Unknown(other.into()),
        }
    }
    Invocation::Audit(AuditArgs {
        slot,
        since,
        denied,
        json,
    })
}

fn parse_setup(args: &[String]) -> Invocation {
    let mut slot = None;
    let mut profile = None;
    let mut allow_raw: Option<&str> = None;
    let mut audit = None;
    let mut yes = false;
    let mut json = false;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--slot" => {
                let Some(value) = args.get(index + 1) else {
                    return Invocation::Invalid("--slot needs a value.".to_string());
                };
                let Some(parsed) = parse_slot(value) else {
                    return Invocation::Invalid(format!(
                        "--slot takes host, wsl, or remote, not \"{value}\"."
                    ));
                };
                slot = Some(parsed);
                index += 2;
            }
            "--profile" => {
                let Some(value) = args.get(index + 1) else {
                    return Invocation::Invalid("--profile needs a value.".to_string());
                };
                let Some(parsed) = setup::parse_setup_profile(value) else {
                    return Invocation::Invalid(format!(
                        "--profile takes full, readonly, or none, not \"{value}\"."
                    ));
                };
                profile = Some(parsed);
                index += 2;
            }
            "--allow" => {
                let Some(value) = args.get(index + 1) else {
                    return Invocation::Invalid("--allow needs a value.".to_string());
                };
                allow_raw = Some(value);
                index += 2;
            }
            "--audit" => {
                let Some(value) = args.get(index + 1) else {
                    return Invocation::Invalid("--audit takes on or off.".into());
                };
                let Some(parsed) = setup::parse_boolean(value) else {
                    return Invocation::Invalid(format!("--audit takes on or off, not {value:?}."));
                };
                audit = Some(parsed);
                index += 2;
            }
            "--yes" | "-y" => {
                yes = true;
                index += 1;
            }
            "--json" => {
                json = true;
                index += 1;
            }
            other => return Invocation::Unknown(other.to_string()),
        }
    }
    let allow = match allow_raw.map(parse_allow_overrides) {
        Some(Ok(parsed)) => parsed,
        Some(Err(reason)) => return Invocation::Invalid(reason),
        None => Vec::new(),
    };
    Invocation::Setup(SetupArgs {
        slot,
        profile,
        allow,
        audit,
        yes,
        json,
    })
}

fn parse_serve(args: &[String]) -> Invocation {
    let mut listen = None;
    let mut token_source = TokenSource::default();
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--listen" => {
                let Some(value) = args.get(index + 1) else {
                    return Invocation::Invalid("--listen needs a value.".to_string());
                };
                listen = Some(value.clone());
                index += 2;
            }
            "--token" => {
                let Some(value) = args.get(index + 1) else {
                    return Invocation::Invalid("--token needs a value.".to_string());
                };
                let Some(parsed) = parse_token_source(value) else {
                    return Invocation::Invalid(format!(
                        "--token takes - or env, not \"{value}\"."
                    ));
                };
                token_source = parsed;
                index += 2;
            }
            other => return Invocation::Unknown(other.to_string()),
        }
    }
    Invocation::Serve(ServeArgs {
        listen,
        token_source,
    })
}

fn parse_connect(args: &[String]) -> Invocation {
    let mut hub = None;
    let mut token_source = TokenSource::default();
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--hub" => {
                let Some(value) = args.get(index + 1) else {
                    return Invocation::Invalid("--hub needs a value.".to_string());
                };
                hub = Some(value.clone());
                index += 2;
            }
            "--token" => {
                let Some(value) = args.get(index + 1) else {
                    return Invocation::Invalid("--token needs a value.".to_string());
                };
                let Some(parsed) = parse_token_source(value) else {
                    return Invocation::Invalid(format!(
                        "--token takes - or env, not \"{value}\"."
                    ));
                };
                token_source = parsed;
                index += 2;
            }
            other => return Invocation::Unknown(other.to_string()),
        }
    }
    Invocation::Connect(ConnectArgs { hub, token_source })
}

/// Runs the CLI over `args` (excluding `argv[0]`), reading environment
/// variables from `env`, and returns the process exit code.
///
/// `env` is threaded through explicitly, the same way [`RuntimeConfig`]
/// itself takes an [`EnvSource`] — every disk path this module touches
/// (`MANGO_HOME`, a token, a stored listen address or hub URL) is derived
/// from it, so a test exercises this dispatcher against a [`crate::config::MapEnv`] and
/// never the real process environment or a real `~/.mango`.
///
/// # Example
///
/// ```
/// use mangostudio_runtime::cli::run;
/// use mangostudio_runtime::config::ProcessEnv;
///
/// assert_eq!(run(&["--version".to_string()], &ProcessEnv), 0);
/// ```
#[must_use]
pub fn run(args: &[String], env: &impl EnvSource) -> i32 {
    match parse(args) {
        Invocation::Version => {
            // The bare version, the same line the TypeScript runtime prints:
            // the hub's doctor probe and the WSL/SSH provisioning checks
            // compare `--version` stdout to a release string verbatim.
            println!("{VERSION}");
            0
        }
        Invocation::Help | Invocation::Empty => {
            print_help();
            0
        }
        Invocation::Unknown(argument) => {
            eprintln!("mangostudio-runtime: unrecognised argument \"{argument}\"");
            eprintln!();
            print_help();
            1
        }
        Invocation::Invalid(reason) => {
            eprintln!("mangostudio-runtime: {reason}");
            1
        }
        Invocation::Setup(args) => run_setup(args, env),
        Invocation::Install(args) => native_operation::run_install(args, env, VERSION),
        Invocation::Health { json } => native_operation::run_health(json, env, VERSION),
        Invocation::Doctor { json } => native_operation::run_doctor(json, env, VERSION),
        Invocation::Service(args) => native_operation::run_service(args, env),
        Invocation::Audit(args) => native_operation::run_audit(args, env),
        Invocation::Stdio => run_stdio(env),
        Invocation::Serve(args) => run_serve(args, env),
        Invocation::Connect(args) => run_connect(args, env),
    }
}

fn print_help() {
    println!("{}", USAGE.replace("{VERSION}", VERSION));
}

fn mango_home(env: &impl EnvSource) -> std::io::Result<PathBuf> {
    RuntimeConfig::from_env(env).map(|config| config.mango_home)
}

fn run_setup(args: SetupArgs, env: &impl EnvSource) -> i32 {
    let config = match RuntimeConfig::from_env(env) {
        Ok(config) => config,
        Err(error) => {
            return setup_fail(args.json, &format!("could not resolve MANGO_HOME: {error}"));
        }
    };
    let home = config.mango_home;
    let slot = args
        .slot
        .unwrap_or_else(|| resolve_runtime_slot_for_current_exe(&home));

    if let Some(enabled) = args.audit
        && args.profile.is_none()
        && args.allow.is_empty()
    {
        let state = read_runtime_slot_config(slot, &home);
        if let Some(error) = state.error.as_ref() {
            return setup_fail(args.json, &error.to_string());
        }
        let pending_without_answer = state
            .stored
            .as_ref()
            .and_then(|value| value.pointer("/setup/state"))
            .and_then(serde_json::Value::as_str)
            != Some("configured")
            && state.stored.is_none();
        if pending_without_answer {
            return setup_fail(
                args.json,
                "Nothing to answer with: pass --profile full|readonly|none before toggling audit, or set MANGOSTUDIO_RUNTIME_SETUP.",
            );
        }
        if !args.yes && !args.json {
            return setup_fail(
                args.json,
                "Pass --yes with --audit on|off to change the audit log without re-answering consent.",
            );
        }
        let updates = [
            ("audit", Some(serde_json::json!({"enabled":enabled}))),
            (
                "source",
                Some(serde_json::json!(
                    crate::runtime_home::resolve_runtime_source_for_current_exe(&home)
                )),
            ),
            ("version", Some(serde_json::json!(VERSION))),
        ];
        match write_runtime_slot_config(slot, &home, &updates) {
            Ok(outcome) => report_replaced_unusable(outcome.replaced_unusable.as_ref()),
            Err(error) => return setup_fail(args.json, &error.to_string()),
        }
        if args.json {
            return setup_health_json(slot, &home);
        }
        println!(
            "Audit {} for the {slot} runtime.\n  {}",
            if enabled { "on" } else { "off" },
            crate::runtime_home::slot_dir(slot, &home).display()
        );
        return 0;
    }

    let profile = match setup::resolve_profile_source_from_raw_env(
        args.profile,
        config.setup_profile.as_deref(),
    ) {
        Ok(Some(profile)) => profile,
        Ok(None) => {
            return setup_fail(
                args.json,
                "Nothing to answer with: pass --profile full|readonly|none, or set MANGOSTUDIO_RUNTIME_SETUP.",
            );
        }
        Err(error) => return setup_fail(args.json, &error),
    };
    let request = NonInteractiveSetupRequest {
        slot,
        profile,
        allow_overrides: &args.allow,
    };
    match setup::run_non_interactive_setup_with_audit(&request, &home, &SystemWallClock, args.audit)
    {
        Ok(outcome) => {
            report_replaced_unusable(outcome.replaced_unusable.as_ref());
            if args.json {
                return setup_health_json(slot, &home);
            }
            println!(
                "Configured the {slot} runtime as {}.",
                outcome.profile.as_str()
            );
            i32::from(outcome.exit_code())
        }
        Err(error) => setup_fail(args.json, &error.to_string()),
    }
}

fn setup_health_json(slot: RuntimeSlot, home: &std::path::Path) -> i32 {
    match native_operation::health_value_for(slot, home, VERSION) {
        Ok(report) => {
            println!("{report}");
            0
        }
        Err(error) => setup_fail(true, &error.to_string()),
    }
}

fn setup_fail(json: bool, message: &str) -> i32 {
    if json {
        println!("{}", serde_json::json!({"error":message}));
    } else {
        eprintln!("mangostudio-runtime: {message}");
    }
    1
}

/// Reports a replacement using only its path and failure category. A schema
/// violation can contain stored values, including credentials.
fn report_replaced_unusable(replaced: Option<&SlotFileError>) {
    let Some((path, reason)) = replaced.map(|error| match error {
        SlotFileError::Unreadable { path, .. } => (path, "unreadable file"),
        SlotFileError::Malformed { path, .. } => (path, "malformed JSON"),
        SlotFileError::SchemaInvalid { path, .. } => (path, "invalid schema"),
    }) else {
        return;
    };
    eprintln!(
        "mangostudio-runtime: warning: replaced unusable {} ({reason}). Review this slot's permissions and credentials.",
        path.display()
    );
}

fn mango_home_or_report(env: &impl EnvSource) -> Option<PathBuf> {
    match mango_home(env) {
        Ok(home) => Some(home),
        Err(error) => {
            eprintln!("mangostudio-runtime: could not resolve MANGO_HOME: {error}");
            None
        }
    }
}

fn build_runtime() -> std::io::Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
}

/// How long exiting waits for blocking work that is still running once a
/// host's session or loop has ended.
///
/// Dropping a Tokio runtime waits for every blocking task without limit. The
/// stdio transport's stdin reader stays blocked in `read` for as long as the
/// parent holds the pipe open, so a signalled stdio runtime never exited. Work
/// still running after this grace ends with the process, like every other
/// resource.
const RUNTIME_SHUTDOWN_GRACE: std::time::Duration = std::time::Duration::from_secs(2);

/// Waits for every MCP server and terminal this process still owns to release, within the
/// shutdown budget, then shuts `runtime` down without waiting on blocking work past
/// [`RUNTIME_SHUTDOWN_GRACE`] or the budget's exit deadline, whichever comes first.
///
/// Dropping the runtime cancels every async task at once, so without the release wait each
/// child's teardown would be cut short and its tree reaped by the parent-death lease instead of
/// given its end of input and SIGTERM. See [`crate::release`] for how the budget fits the Hub's
/// escalation window.
///
/// # Example
///
/// ```ignore
/// let code = runtime.block_on(session);
/// shut_down(runtime);
/// ```
fn shut_down(runtime: tokio::runtime::Runtime) {
    let release = crate::release::Release::process();
    if !runtime.block_on(release.released()) {
        eprintln!(
            "mangostudio-runtime: some MCP servers or terminals had not released within {:?}; \
             exiting ends them.",
            crate::release::SHUTDOWN_BUDGET
        );
    }
    runtime.shutdown_timeout(release.exit_grace(RUNTIME_SHUTDOWN_GRACE));
}

/// Starts the shutdown budget the moment `cancel` fires rather than when the host's loop has
/// finished draining, so the child release runs alongside that drain inside one window.
fn begin_release_on(cancel: &CancellationToken) {
    let cancel = cancel.clone();
    tokio::spawn(async move {
        cancel.cancelled().await;
        crate::release::Release::process().begin();
    });
}

/// Lets an active installer finish after a user service's signal-driven stop.
/// The service unit enforces the final 30-second process cap.
async fn settle_installer_until_service_cap() {
    settle_installer_until(
        crate::release::Release::process(),
        crate::install::settled(),
    )
    .await;
}

async fn settle_installer_until(
    release: &crate::release::Release,
    settled: impl std::future::Future<Output = ()>,
) {
    tokio::select! {
        () = settled => {}
        () = release.cutoff(std::time::Duration::from_secs(27)) => {}
    }
}

fn run_stdio(env: &impl EnvSource) -> i32 {
    let Some(home) = mango_home_or_report(env) else {
        return 1;
    };
    let Ok(runtime) = build_runtime() else {
        eprintln!("mangostudio-runtime: could not start the async runtime.");
        return 1;
    };
    let signals = {
        let _entered = runtime.enter();
        crate::supervisor::ShutdownSignals::install()
    };
    let Ok(signals) = signals else {
        eprintln!("mangostudio-runtime: could not install signal handlers.");
        return 1;
    };
    let result = runtime.block_on(crate::transport::stdio::run_with_signals(
        VERSION, &home, signals,
    ));
    shut_down(runtime);
    match result {
        Ok(code) => code,
        Err(error) => {
            eprintln!("mangostudio-runtime: {error}");
            1
        }
    }
}

fn run_serve(args: ServeArgs, env: &impl EnvSource) -> i32 {
    let Some(home) = mango_home_or_report(env) else {
        return 1;
    };

    let stored_listen =
        read_runtime_slot_config(RuntimeSlot::Remote, &home).stored_string("serveListen");
    let Some(raw_listen) = args.listen.clone().or(stored_listen) else {
        eprintln!(
            "mangostudio-runtime: no listen address. Pass --listen <host:port>, or run serve \
             once to remember it."
        );
        return 1;
    };
    let Some(addr) = parse_listen_address(&raw_listen) else {
        eprintln!("mangostudio-runtime: invalid --listen value. Pass a port, or host:port.");
        return 1;
    };
    // A security-relevant default, not a corner case to stay silent about:
    // whoever holds the serve token gets shell access on this machine, and
    // that reach is no longer bounded to this machine alone once `--listen`
    // resolves beyond loopback.
    if !addr.ip().is_loopback() {
        eprintln!(
            "mangostudio-runtime: listening on {addr}. Whoever holds the serve token gets shell \
             access on this machine."
        );
    }

    // Resolve an explicitly named source before consent. A fresh remote
    // slot records a full grant when the invocation itself is the consent;
    // an empty `--token env` or `--token stdin` must not record that grant
    // for an invocation that cannot serve anything. The default source is
    // allowed to fall through to token generation, but generation stays
    // after consent so an installer-armed pending slot does not gain a
    // credential before its owner answers the setup gate.
    let Ok(resolved_token) = resolve_token(args.token_source, "serveToken", env) else {
        return 1;
    };
    if resolved_token.is_none() && args.token_source != TokenSource::EnvOrStored {
        eprintln!(
            "mangostudio-runtime: no serve token. Pipe one in with --token -, or set \
             MANGOSTUDIO_RUNTIME_SERVE_TOKEN."
        );
        return 1;
    }

    if !remote_invocation_consent(&home) {
        return 1;
    }

    let token = match resolved_token {
        Some(token) => token,
        // Only the default source falls all the way through to generating
        // one: an explicit `--token stdin`/`--token env` that came back
        // empty is a caller naming a specific source, not asking for a
        // fresh credential — mirrors `resolveServeToken`'s own precedence.
        None if args.token_source == TokenSource::EnvOrStored => {
            match crate::runtime_home::bootstrap_serve_token(RuntimeSlot::Remote, &home) {
                Ok((token, outcome, restricted)) => {
                    report_replaced_unusable(outcome.replaced_unusable.as_ref());
                    if !restricted {
                        eprintln!(
                            "mangostudio-runtime: warning: the serve token file could not be \
                             restricted to this user."
                        );
                    }
                    eprintln!("mangostudio-runtime: serve token (shown once): {token}");
                    token
                }
                Err(error) => {
                    eprintln!("mangostudio-runtime: could not generate a serve token: {error}");
                    return 1;
                }
            }
        }
        None => unreachable!("an explicit empty token source returned before consent"),
    };

    match write_runtime_slot_config(
        RuntimeSlot::Remote,
        &home,
        &[("serveListen", Some(serde_json::Value::String(raw_listen)))],
    ) {
        Ok(outcome) => report_replaced_unusable(outcome.replaced_unusable.as_ref()),
        Err(error) => {
            eprintln!("mangostudio-runtime: {error}");
            return 1;
        }
    }

    let Ok(runtime) = build_runtime() else {
        eprintln!("mangostudio-runtime: could not start the async runtime.");
        return 1;
    };
    let code = runtime.block_on(async move {
        // Installed before anything else in this block, including the bind
        // below: a signal is eagerly registered here (never lazily, inside
        // a `select!` reached after setup work — see
        // `crate::supervisor::ShutdownSignals`'s own doc comment for why
        // that distinction matters) rather than after work that could
        // itself stall.
        let Ok(signals) = crate::supervisor::ShutdownSignals::install() else {
            eprintln!("mangostudio-runtime: could not install signal handlers.");
            return 1;
        };
        let cancel = CancellationToken::new();
        let signal_task = signals.watch(cancel.clone());
        begin_release_on(&cancel);
        let stopping = cancel.clone();

        let listener = match tokio::net::TcpListener::bind(addr).await {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!("mangostudio-runtime: could not bind {addr}: {error}");
                return 1;
            }
        };
        let log = |message: &str| eprintln!("mangostudio-runtime: {message}");
        let code = match crate::transport::serve::run(
            listener,
            token,
            RuntimeSlot::Remote,
            home,
            VERSION.to_string(),
            cancel,
            log,
        )
        .await
        {
            Ok(()) => 0,
            Err(error) => {
                eprintln!("mangostudio-runtime: {error}");
                1
            }
        };
        // `serve::run`'s accept loop only ever returns once `cancel` fired,
        // and the signal watcher above is the only holder of the sending
        // side, so this task has already finished (or is about to) by now
        // — never a wait on a signal that may never come.
        let _ = crate::supervisor::join_owned(signal_task).await;
        if stopping.is_cancelled() {
            settle_installer_until_service_cap().await;
        }
        code
    });
    shut_down(runtime);
    code
}

fn run_connect(args: ConnectArgs, env: &impl EnvSource) -> i32 {
    let Some(home) = mango_home_or_report(env) else {
        return 1;
    };

    let stored_hub = read_runtime_slot_config(RuntimeSlot::Remote, &home).stored_string("hubUrl");
    let Some(hub_url) = args.hub.clone().or(stored_hub) else {
        eprintln!(
            "mangostudio-runtime: no hub URL. Pass --hub <url>; the pairing card in \
             MangoStudio prints it."
        );
        return 1;
    };

    // Token resolution runs before consent, not after: on a never-before-
    // answered slot, consent below records `configured`/`profile: full`
    // the instant it runs — permanently, since a later failure never
    // rewinds it. Resolving the token first means a `connect` that goes on
    // to refuse for want of a token never converts a `pending` slot into
    // one that recorded a grant it then failed to use for anything.
    let Ok(token) = resolve_token(args.token_source, "pairingToken", env) else {
        return 1;
    };
    let Some(token) = token else {
        eprintln!(
            "mangostudio-runtime: no pairing token. Pipe one in with --token -, or set \
             MANGOSTUDIO_RUNTIME_TOKEN."
        );
        return 1;
    };

    if !remote_invocation_consent(&home) {
        return 1;
    }

    match write_runtime_slot_config(
        RuntimeSlot::Remote,
        &home,
        &[("hubUrl", Some(serde_json::Value::String(hub_url.clone())))],
    ) {
        Ok(outcome) => report_replaced_unusable(outcome.replaced_unusable.as_ref()),
        Err(error) => {
            eprintln!("mangostudio-runtime: {error}");
            return 1;
        }
    }
    match crate::runtime_home::write_runtime_slot_credentials(
        RuntimeSlot::Remote,
        &home,
        &[(
            "pairingToken",
            Some(serde_json::Value::String(token.clone())),
        )],
    ) {
        Ok((outcome, restricted)) => {
            report_replaced_unusable(outcome.replaced_unusable.as_ref());
            if !restricted {
                eprintln!(
                    "mangostudio-runtime: warning: the pairing token file could not be \
                     restricted to this user."
                );
            }
        }
        Err(error) => {
            eprintln!("mangostudio-runtime: {error}");
            return 1;
        }
    }

    let Ok(runtime) = build_runtime() else {
        eprintln!("mangostudio-runtime: could not start the async runtime.");
        return 1;
    };
    let code = runtime.block_on(async move {
        // See the identical comment in `run_serve`: installed first, always.
        let Ok(signals) = crate::supervisor::ShutdownSignals::install() else {
            eprintln!("mangostudio-runtime: could not install signal handlers.");
            return 1;
        };
        let cancel = CancellationToken::new();
        let signal_task = signals.watch(cancel.clone());
        begin_release_on(&cancel);

        let jitter = RandomJitter::default();
        let log = |message: &str| eprintln!("mangostudio-runtime: {message}");
        let config = crate::transport::connect::ConnectConfig {
            hub_url,
            token,
            slot: RuntimeSlot::Remote,
            mango_home: home,
            runtime_version: VERSION.to_string(),
        };
        match crate::transport::connect::run(config, cancel, &jitter, log).await {
            crate::transport::connect::ConnectOutcome::Stopped => {
                // `cancel` only ever comes from `signal_task` here, so
                // `Stopped` means it has already fired (and so finished, or
                // is about to) — safe, and correct, to await it.
                let _ = crate::supervisor::join_owned(signal_task).await;
                settle_installer_until_service_cap().await;
                0
            }
            crate::transport::connect::ConnectOutcome::Refused { message } => {
                eprintln!("mangostudio-runtime: {message}");
                // The process is exiting on the hub's refusal, not the
                // signal — `signal_task` may never resolve at all now, so
                // awaiting it here would hang. It is not aborted either:
                // simply dropping the handle detaches it, and `shut_down`
                // below reclaims it the same way process exit reclaims every
                // other resource, never a task this code chose to abandon
                // while it still had something left to do.
                1
            }
        }
    });
    shut_down(runtime);
    code
}

/// The remote slot's "invocation is consent" gate shared by `serve` and
/// `connect`: reports a refusal or a freshly recorded grant on stderr and
/// returns whether this invocation may serve.
fn remote_invocation_consent(home: &std::path::Path) -> bool {
    let consent = consent_by_invocation(RuntimeSlot::Remote, home, VERSION, &SystemWallClock);
    report_replaced_unusable(consent.replaced_unusable.as_ref());
    if !consent.granted {
        if let Some(reason) = &consent.reason {
            eprintln!("mangostudio-runtime: {reason}");
        }
        eprintln!(
            "mangostudio-runtime: {}",
            crate::consent::invocation::setup_pending_message()
        );
        return false;
    }
    if consent.recorded {
        eprintln!(
            "mangostudio-runtime: recorded full permissions for this machine. Run \"{}\" to \
             narrow them.",
            setup_command(Some(RuntimeSlot::Remote))
        );
    }
    true
}

/// Resolves a bearer credential per [`TokenSource`]: `Stdin` reads one
/// trimmed line, `Env` reads only the environment variable, and the default
/// falls back to `credentials.json`'s `field` when the environment is
/// empty. Never generates one itself — `run_serve` is the only caller that
/// falls through to [`crate::runtime_home::bootstrap_serve_token`] on the
/// default source, mirroring `resolveServeToken`'s own precedence in
/// `cli.ts` (an explicit `stdin`/`env` source that came back empty is
/// refused, never silently upgraded to a freshly generated credential).
///
/// `Err(CredentialsRefused)` means the stored `credentials.json` was
/// refused and its reason and remedy already went to stderr, so the
/// caller must not follow them with its own generic "no token" line —
/// mirroring `resolveToken`'s `diagnosed` flag in `cli.ts`.
fn resolve_token(
    source: TokenSource,
    field: &str,
    env: &impl EnvSource,
) -> Result<Option<String>, CredentialsRefused> {
    match source {
        TokenSource::Stdin => {
            // `read_line`, not `read_to_string`: the latter blocks until
            // EOF, which an interactive terminal never sends on its own
            // (a person would have to know to press Ctrl+D) — exactly the
            // hang this doc comment's "one trimmed line" promises not to
            // cause. `read_line` returns as soon as a newline arrives,
            // which is what a piped `echo "$TOKEN" | mangostudio-runtime
            // serve --token stdin` (or a person typing one line and
            // pressing Enter) actually produces.
            let mut buffer = String::new();
            if std::io::stdin().lock().read_line(&mut buffer).is_err() {
                return Ok(None);
            }
            let trimmed = buffer.trim();
            Ok((!trimmed.is_empty()).then(|| trimmed.to_string()))
        }
        TokenSource::Env | TokenSource::EnvOrStored => {
            let Ok(config) = RuntimeConfig::from_env(env) else {
                return Ok(None);
            };
            let from_env = if field == "serveToken" {
                config.serve_token
            } else {
                config.pairing_token
            };
            if source == TokenSource::Env || from_env.is_some() {
                return Ok(from_env);
            }
            if let Some(reason) =
                crate::runtime_home::credentials_refusal(RuntimeSlot::Remote, &config.mango_home)
            {
                eprintln!("mangostudio-runtime: {reason} {CREDENTIALS_REFUSED_REMEDY}");
                return Err(CredentialsRefused);
            }
            Ok(crate::runtime_home::read_runtime_slot_credentials(
                RuntimeSlot::Remote,
                &config.mango_home,
            )
            .stored_string(field))
        }
    }
}

/// A stored `credentials.json` was refused and already diagnosed on
/// stderr; see [`resolve_token`].
#[derive(Debug)]
struct CredentialsRefused;

/// The one remedy for a refused `credentials.json`, mirroring
/// `runtime-home.ts`'s `credentialsRemedy`: only an operator can judge the
/// file safe to discard, and the command that hit it writes a fresh one.
const CREDENTIALS_REFUSED_REMEDY: &str =
    "Move it aside, then run this command; it will write a fresh credentials.json in its place.";

/// Parses `--listen`: a bare port binds loopback, `host:port` resolves that
/// host. Mirrors `serve.ts`'s `parseListenAddress`, resolved to a concrete
/// [`SocketAddr`] via a synchronous DNS lookup — a one-shot startup cost,
/// run before the Tokio runtime exists, never inside it.
fn parse_listen_address(value: &str) -> Option<SocketAddr> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(port) = trimmed.parse::<u16>() {
        return Some(SocketAddr::from(([127, 0, 0, 1], port)));
    }
    // A bracketed IPv6 literal, `[<addr>]:<port>` — handled before the
    // generic `rfind(':')` split below, which would otherwise hand
    // `to_socket_addrs` the host `"[::1]"`, brackets included:
    // `IpAddr::from_str` does not accept those, so a literal that looks
    // exactly like the standard `host:port` convention for IPv6 silently
    // failed to parse at all.
    if let Some(rest) = trimmed.strip_prefix('[') {
        let (addr, after) = rest.split_once(']')?;
        let port_text = after.strip_prefix(':')?.trim();
        let ip: std::net::Ipv6Addr = addr.parse().ok()?;
        let port: u16 = port_text.parse().ok()?;
        return Some(SocketAddr::from((ip, port)));
    }
    let separator = trimmed.rfind(':')?;
    if separator == 0 {
        return None;
    }
    let host = trimmed[..separator].trim();
    let port_text = trimmed[separator + 1..].trim();
    if host.is_empty() {
        return None;
    }
    let port: u16 = port_text.parse().ok()?;
    (host, port).to_socket_addrs().ok()?.next()
}

#[cfg(test)]
mod tests {
    use super::{Invocation, TokenSource, parse, parse_listen_address, parse_token_source, run};
    use crate::config::MapEnv;
    use crate::test_support::{ScratchDir, scratch_path};

    /// A scratch `MANGO_HOME` per test, so `run`'s own disk-touching paths
    /// (`consent_by_invocation`'s auto-grant among them) never read or write
    /// a real user's `~/.mango` — this crate denies `unsafe_code`, so a test
    /// here has no `std::env::set_var` escape hatch even if it wanted one;
    /// [`super::run`] takes an [`crate::config::EnvSource`] for exactly this
    /// reason. Uses [`scratch_path`], not [`crate::test_support::scratch_dir`]:
    /// `run` itself must be the one to create `MANGO_HOME` on first use, the
    /// same way a real invocation would find it absent. The returned
    /// [`ScratchDir`] guard must stay bound in the caller for as long as the
    /// env is in use — dropping it removes the directory.
    fn scratch_env(name: &str) -> (ScratchDir, MapEnv) {
        let home = scratch_path(name);
        let env = MapEnv::from([("MANGO_HOME", home.to_str().unwrap())]);
        (home, env)
    }

    #[test]
    fn stdio_is_accepted_under_both_spellings() {
        assert!(matches!(parse(&["stdio".to_string()]), Invocation::Stdio));
        assert!(matches!(parse(&["--stdio".to_string()]), Invocation::Stdio));
    }

    #[test]
    fn native_operation_commands_parse_with_their_documented_flags() {
        assert!(matches!(
            parse(&[
                "install".into(),
                "--slot".into(),
                "remote".into(),
                "--json".into()
            ]),
            Invocation::Install(_)
        ));
        assert!(matches!(
            parse(&["health".into(), "--json".into()]),
            Invocation::Health { json: true }
        ));
        assert!(matches!(
            parse(&["doctor".into()]),
            Invocation::Doctor { json: false }
        ));
        assert!(matches!(
            parse(&["service".into(), "restart".into()]),
            Invocation::Service(_)
        ));
        assert!(matches!(
            parse(&["service".into(), "stop".into(), "--force".into()]),
            Invocation::Service(args) if args.force
        ));
        assert!(matches!(
            parse(&["service".into(), "start".into(), "--force".into()]),
            Invocation::Unknown(flag) if flag == "--force"
        ));
        assert!(matches!(
            parse(&["audit".into(), "--denied".into()]),
            Invocation::Audit(_)
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn native_service_stop_waits_for_installer_but_never_past_27_seconds() {
        let release = crate::release::Release::new();
        release.begin();
        let start = tokio::time::Instant::now();
        super::settle_installer_until(&release, std::future::pending()).await;
        assert_eq!(start.elapsed(), std::time::Duration::from_secs(27));

        let release = crate::release::Release::new();
        release.begin();
        let start = tokio::time::Instant::now();
        super::settle_installer_until(&release, async {}).await;
        assert_eq!(start.elapsed(), std::time::Duration::ZERO);
    }

    #[test]
    fn a_trailing_argument_after_either_stdio_spelling_is_unknown() {
        assert!(matches!(
            parse(&["--stdio".to_string(), "extra".to_string()]),
            Invocation::Unknown(argument) if argument == "extra"
        ));
    }

    #[test]
    fn token_source_accepts_the_dash_the_product_actually_shows() {
        assert_eq!(parse_token_source("-"), Some(TokenSource::Stdin));
        // `stdin` stays as an accepted alias, not dropped.
        assert_eq!(parse_token_source("stdin"), Some(TokenSource::Stdin));
        assert_eq!(parse_token_source("env"), Some(TokenSource::Env));
        assert_eq!(parse_token_source("nonsense"), None);
    }

    #[test]
    fn a_bare_port_binds_loopback() {
        let addr = parse_listen_address("8080").unwrap();
        assert_eq!(addr.ip().to_string(), "127.0.0.1");
        assert_eq!(addr.port(), 8080);
    }

    #[test]
    fn a_host_port_pair_resolves_the_host() {
        let addr = parse_listen_address("127.0.0.1:9090").unwrap();
        assert_eq!(addr.port(), 9090);
    }

    #[test]
    fn a_bracketed_ipv6_literal_resolves_correctly() {
        let addr = parse_listen_address("[::1]:8080").expect(
            "a bracketed IPv6 literal must parse; the generic rfind(':') split would otherwise \
             hand to_socket_addrs the bracketed host \"[::1]\", which IpAddr::from_str refuses",
        );
        assert_eq!(
            addr.ip(),
            std::net::IpAddr::V6(std::net::Ipv6Addr::LOCALHOST)
        );
        assert_eq!(addr.port(), 8080);
    }

    #[test]
    fn a_bracketed_ipv6_literal_with_no_port_is_rejected() {
        assert!(parse_listen_address("[::1]").is_none());
        assert!(parse_listen_address("[::1]:").is_none());
        assert!(parse_listen_address("[not-an-ip]:8080").is_none());
    }

    #[test]
    fn a_blank_value_is_rejected() {
        assert!(parse_listen_address("   ").is_none());
    }

    #[test]
    fn an_out_of_range_port_is_rejected() {
        assert!(parse_listen_address("99999").is_none());
    }

    #[test]
    fn version_and_help_still_exit_zero() {
        let (_home, env) = scratch_env("version-help");
        assert_eq!(run(&["--version".to_string()], &env), 0);
        assert_eq!(run(&["--help".to_string()], &env), 0);
        assert_eq!(run(&[], &env), 0);
    }

    #[test]
    fn an_unrecognised_top_level_command_exits_one() {
        let (_home, env) = scratch_env("unrecognised");
        assert_eq!(run(&["--not-a-real-flag".to_string()], &env), 1);
    }

    #[test]
    fn setup_without_a_profile_exits_one() {
        let (_home, env) = scratch_env("setup-no-profile");
        assert_eq!(run(&["setup".to_string()], &env), 1);
    }

    #[test]
    fn setup_accepts_environment_profile_and_audit_only_without_changing_consent() {
        let home = scratch_path("setup-env-audit");
        let env = MapEnv::from([
            ("MANGO_HOME", home.to_str().unwrap()),
            ("MANGOSTUDIO_RUNTIME_SETUP", "readonly"),
        ]);
        assert_eq!(
            run(&["setup".into(), "--slot".into(), "remote".into()], &env),
            0
        );
        let before = crate::runtime_home::read_runtime_slot_config(
            crate::runtime_home::RuntimeSlot::Remote,
            &home,
        )
        .stored
        .unwrap();
        assert_eq!(before["setup"]["by"], "env");
        assert_eq!(
            run(
                &[
                    "setup".into(),
                    "--slot".into(),
                    "remote".into(),
                    "--audit".into(),
                    "off".into(),
                    "--yes".into()
                ],
                &env
            ),
            0
        );
        let after = crate::runtime_home::read_runtime_slot_config(
            crate::runtime_home::RuntimeSlot::Remote,
            &home,
        )
        .stored
        .unwrap();
        assert_eq!(after["allow"], before["allow"]);
        assert_eq!(after["audit"]["enabled"], false);
        assert_eq!(after["setup"], before["setup"]);
    }

    #[test]
    fn audit_only_refuses_to_answer_an_unconfigured_slot() {
        let (_home, env) = scratch_env("setup-audit-pending");
        for slot in ["host", "wsl", "remote"] {
            assert_eq!(
                run(
                    &[
                        "setup".into(),
                        "--slot".into(),
                        slot.into(),
                        "--audit".into(),
                        "on".into(),
                        "--yes".into()
                    ],
                    &env
                ),
                1,
                "{slot} must not acquire audit config without a recorded answer"
            );
        }
    }

    #[test]
    fn setup_with_an_invalid_profile_exits_one() {
        let (_home, env) = scratch_env("setup-invalid-profile");
        assert_eq!(
            run(
                &[
                    "setup".to_string(),
                    "--profile".to_string(),
                    "not-a-profile".to_string()
                ],
                &env
            ),
            1
        );
    }

    #[test]
    fn setup_with_a_valid_profile_writes_it_and_exits_zero() {
        let (_home, env) = scratch_env("setup-valid-profile");
        assert_eq!(
            run(
                &[
                    "setup".to_string(),
                    "--slot".to_string(),
                    "remote".to_string(),
                    "--profile".to_string(),
                    "readonly".to_string()
                ],
                &env
            ),
            0
        );
    }

    #[test]
    fn serve_with_no_listen_address_and_nothing_stored_exits_one() {
        let (_home, env) = scratch_env("serve-no-listen");
        assert_eq!(run(&["serve".to_string()], &env), 1);
    }

    #[test]
    fn connect_with_no_hub_url_and_nothing_stored_exits_one() {
        let (_home, env) = scratch_env("connect-no-hub");
        assert_eq!(run(&["connect".to_string()], &env), 1);
    }

    /// A `remote` slot an installer armed to `pending` refuses `connect`
    /// even though a hub URL and a token are both supplied — the
    /// setup-pending gate runs before either is even asked for.
    #[test]
    fn connect_refuses_a_slot_armed_pending_even_with_a_hub_and_token() {
        let (_home, env) = scratch_env("connect-pending");
        let home = crate::config::RuntimeConfig::from_env(&env)
            .unwrap()
            .mango_home;
        crate::runtime_home::write_runtime_slot_config(
            crate::runtime_home::RuntimeSlot::Remote,
            &home,
            &[(
                "setup",
                Some(serde_json::json!({
                    "state": "pending",
                    "at": "2024-01-01T00:00:00.000Z",
                    "by": "install"
                })),
            )],
        )
        .unwrap();
        let env = MapEnv::from([
            ("MANGO_HOME", home.to_str().unwrap()),
            ("MANGOSTUDIO_RUNTIME_TOKEN", "irrelevant"),
        ]);
        assert_eq!(
            run(
                &[
                    "connect".to_string(),
                    "--hub".to_string(),
                    "wss://hub.example".to_string()
                ],
                &env
            ),
            1
        );
    }

    /// `cli.ts`'s `writeRuntimeSlotConfig(...)` call has no catch, so a
    /// failed remember aborts `runConnect` outright. This port's own
    /// `write_runtime_slot_config` for `hubUrl` used to be `let _ = ...`:
    /// the pairing token would still land on disk (a later, now-fatal
    /// write) while the hub URL silently did not, and the next flagless
    /// `connect` would exit on "no hub URL" with nothing explaining why.
    ///
    /// Forces the failure through the schema rather than the filesystem:
    /// `runtime.json`'s own `hubUrl` field caps at 2048 characters
    /// (`runtime-home.schema.json`), which `--hub`'s own parsing does not
    /// enforce at all, so an oversized value reaches this write and fails
    /// it with `WriteError::SchemaInvalid` — without touching permissions
    /// on the slot directory, which `consent_by_invocation`'s own lock
    /// file lives in too and would fail *that* step instead of this one
    /// if denied.
    ///
    /// `run` runs on its own thread here, joined with a bounded wait: the
    /// regression this guards is not a wrong exit code but a *silent*
    /// continue, which reaches `connect::run`'s real dial loop against a
    /// `--hub` this test never intends to answer — measured directly by
    /// reverting the fix, which made this hang past `cargo test`'s own
    /// external timeout rather than fail with any assertion at all. A
    /// bounded `recv_timeout` turns that into a fast, clear failure
    /// instead.
    #[test]
    fn connect_reports_and_exits_when_it_cannot_remember_the_hub_url() {
        let oversized_hub_url = format!("wss://hub.example/{}", "x".repeat(2048));
        let (_home, env) = scratch_env("connect-huburl-write-fails");
        let home = crate::config::RuntimeConfig::from_env(&env)
            .unwrap()
            .mango_home;
        let env = MapEnv::from([
            ("MANGO_HOME", home.to_str().unwrap()),
            ("MANGOSTUDIO_RUNTIME_TOKEN", "irrelevant"),
        ]);

        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let exit_code = run(
                &[
                    "connect".to_string(),
                    "--hub".to_string(),
                    oversized_hub_url,
                ],
                &env,
            );
            let _ = sender.send(exit_code);
        });

        let exit_code = receiver
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect(
                "a failed hubUrl remember must exit promptly, not silently continue toward a dial",
            );
        assert_eq!(
            exit_code, 1,
            "a failed hubUrl remember must exit non-zero, not silently continue toward a dial"
        );
    }
}
