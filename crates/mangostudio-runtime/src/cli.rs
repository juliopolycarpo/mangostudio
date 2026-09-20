//! Argument parsing and dispatch for the `mangostudio-runtime` binary.
//!
//! Mirrors the shape of `apps/runtime/src/cli.ts`, scoped to what this
//! crate actually implements: `--version`/`--help` (already there before
//! this change), `setup` (wiring [`crate::setup::run_non_interactive_setup`]
//! behind real flags — no interactive prompting, no audit-only toggle; see
//! that module's own doc comment for why), and the three transports in
//! [`crate::transport`].
//!
//! Every synchronous, disk-touching decision (consent, token resolution,
//! resolving and remembering a listen address or hub URL) happens here,
//! before a Tokio runtime is ever built — never inside one, which is what
//! keeps every `std::fs` call in this module off a Tokio executor thread
//! without a single `spawn_blocking`. Only the transport itself
//! ([`crate::transport::stdio::run`], [`crate::transport::serve::run`],
//! [`crate::transport::connect::run`]) runs inside the runtime this module
//! builds for it.

use std::io::Read as _;
use std::net::{SocketAddr, ToSocketAddrs};
use std::path::PathBuf;

use mangostudio_runtime_contract::manifest::ManifestProfile;
use tokio_util::sync::CancellationToken;

use crate::config::{EnvSource, RuntimeConfig};
use crate::consent::invocation::consent_by_invocation;
use crate::ports::wall_clock::SystemWallClock;
use crate::runtime_home::{
    RuntimeSlot, read_runtime_slot_config, resolve_runtime_slot_for_current_exe,
    write_runtime_slot_config,
};
use crate::setup::{self, NonInteractiveSetupRequest, SetupAuthority, parse_allow_overrides};
use crate::transport::connect::RandomJitter;

const VERSION: &str = env!("CARGO_PKG_VERSION");

const USAGE: &str = "mangostudio-runtime {VERSION}\n\
\n\
Usage: mangostudio-runtime <command> [options]\n\
\n\
Commands:\n\
\x20\x20setup --profile <full|readonly|none> [--slot <host|wsl|remote>] [--allow k=v,...]\n\
\x20\x20stdio\n\
\x20\x20serve --listen <port|host:port> [--token stdin|env]\n\
\x20\x20connect --hub <url> [--token stdin|env]\n\
\n\
Options:\n\
\x20\x20-v, --version  Print the version and exit\n\
\x20\x20-h, --help     Print this message and exit";

/// One parsed invocation.
enum Invocation {
    Version,
    Help,
    Setup(SetupArgs),
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
        "stdin" => Some(TokenSource::Stdin),
        "env" => Some(TokenSource::Env),
        _ => None,
    }
}

fn parse_slot(value: &str) -> Option<RuntimeSlot> {
    match value {
        "host" => Some(RuntimeSlot::Host),
        "wsl" => Some(RuntimeSlot::Wsl),
        "remote" => Some(RuntimeSlot::Remote),
        _ => None,
    }
}

fn parse(args: &[String]) -> Invocation {
    let Some(first) = args.first() else {
        return Invocation::Empty;
    };
    match first.as_str() {
        "--version" | "-v" => Invocation::Version,
        "--help" | "-h" => Invocation::Help,
        "setup" => parse_setup(&args[1..]),
        "stdio" => {
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

fn parse_setup(args: &[String]) -> Invocation {
    let mut slot = None;
    let mut profile = None;
    let mut allow_raw: Option<&str> = None;
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
                        "--token takes stdin or env, not \"{value}\"."
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
                        "--token takes stdin or env, not \"{value}\"."
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
            println!("mangostudio-runtime {VERSION}");
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
    let Some(home) = mango_home_or_report(env) else {
        return 1;
    };
    let Some(profile) = args.profile else {
        eprintln!("mangostudio-runtime: setup needs --profile full|readonly|none.");
        return 1;
    };
    let slot = args
        .slot
        .unwrap_or_else(|| resolve_runtime_slot_for_current_exe(&home));
    let request = NonInteractiveSetupRequest {
        slot,
        profile: (profile, SetupAuthority::Cli),
        allow_overrides: &args.allow,
    };
    match setup::run_non_interactive_setup(&request, &home, &SystemWallClock) {
        Ok(outcome) => {
            println!(
                "Configured the {slot} runtime as {}.",
                setup_profile_str(outcome.profile)
            );
            i32::from(outcome.exit_code())
        }
        Err(error) => {
            eprintln!("mangostudio-runtime: {error}");
            i32::from(error.exit_code())
        }
    }
}

fn setup_profile_str(profile: ManifestProfile) -> &'static str {
    match profile {
        ManifestProfile::Full => "full",
        ManifestProfile::Readonly => "readonly",
        ManifestProfile::None => "none",
        ManifestProfile::Custom => "custom",
    }
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

fn run_stdio(env: &impl EnvSource) -> i32 {
    let Some(home) = mango_home_or_report(env) else {
        return 1;
    };
    let Ok(runtime) = build_runtime() else {
        eprintln!("mangostudio-runtime: could not start the async runtime.");
        return 1;
    };
    match runtime.block_on(crate::transport::stdio::run(VERSION, &home)) {
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

    let stored = read_runtime_slot_config(RuntimeSlot::Remote, &home);
    let stored_listen = stored
        .stored
        .as_ref()
        .and_then(|value| value.get("serveListen"))
        .and_then(|value| value.as_str())
        .map(str::to_string);
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

    let consent = consent_by_invocation(RuntimeSlot::Remote, &home, VERSION, &SystemWallClock);
    if !consent.granted {
        if let Some(reason) = &consent.reason {
            eprintln!("mangostudio-runtime: {reason}");
        }
        eprintln!(
            "mangostudio-runtime: {}",
            crate::consent::invocation::setup_pending_message()
        );
        return 1;
    }

    let token = match resolve_token(args.token_source, "serveToken", env) {
        Some(token) => token,
        // Only the default source falls all the way through to generating
        // one: an explicit `--token stdin`/`--token env` that came back
        // empty is a caller naming a specific source, not asking for a
        // fresh credential — mirrors `resolveServeToken`'s own precedence.
        None if args.token_source == TokenSource::EnvOrStored => {
            match crate::runtime_home::bootstrap_serve_token(RuntimeSlot::Remote, &home) {
                Ok((token, restricted)) => {
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
        None => {
            eprintln!(
                "mangostudio-runtime: no serve token. Pipe one in with --token stdin, or set \
                 MANGOSTUDIO_RUNTIME_SERVE_TOKEN."
            );
            return 1;
        }
    };

    let _ = write_runtime_slot_config(
        RuntimeSlot::Remote,
        &home,
        &[("serveListen", Some(serde_json::Value::String(raw_listen)))],
    );

    let Ok(runtime) = build_runtime() else {
        eprintln!("mangostudio-runtime: could not start the async runtime.");
        return 1;
    };
    runtime.block_on(async move {
        let listener = match tokio::net::TcpListener::bind(addr).await {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!("mangostudio-runtime: could not bind {addr}: {error}");
                return 1;
            }
        };
        let cancel = install_signal_cancellation();
        let log = |message: &str| eprintln!("mangostudio-runtime: {message}");
        match crate::transport::serve::run(
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
        }
    })
}

fn run_connect(args: ConnectArgs, env: &impl EnvSource) -> i32 {
    let Some(home) = mango_home_or_report(env) else {
        return 1;
    };

    let stored = read_runtime_slot_config(RuntimeSlot::Remote, &home);
    let stored_hub = stored
        .stored
        .as_ref()
        .and_then(|value| value.get("hubUrl"))
        .and_then(|value| value.as_str())
        .map(str::to_string);
    let Some(hub_url) = args.hub.clone().or(stored_hub) else {
        eprintln!(
            "mangostudio-runtime: no hub URL. Pass --hub <url>; the pairing card in \
             MangoStudio prints it."
        );
        return 1;
    };

    let consent = consent_by_invocation(RuntimeSlot::Remote, &home, VERSION, &SystemWallClock);
    if !consent.granted {
        if let Some(reason) = &consent.reason {
            eprintln!("mangostudio-runtime: {reason}");
        }
        eprintln!(
            "mangostudio-runtime: {}",
            crate::consent::invocation::setup_pending_message()
        );
        return 1;
    }

    let Some(token) = resolve_token(args.token_source, "pairingToken", env) else {
        eprintln!(
            "mangostudio-runtime: no pairing token. Pipe one in with --token stdin, or set \
             MANGOSTUDIO_RUNTIME_TOKEN."
        );
        return 1;
    };

    let _ = write_runtime_slot_config(
        RuntimeSlot::Remote,
        &home,
        &[("hubUrl", Some(serde_json::Value::String(hub_url.clone())))],
    );

    let Ok(runtime) = build_runtime() else {
        eprintln!("mangostudio-runtime: could not start the async runtime.");
        return 1;
    };
    runtime.block_on(async move {
        let cancel = install_signal_cancellation();
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
            crate::transport::connect::ConnectOutcome::Stopped => 0,
            crate::transport::connect::ConnectOutcome::Refused { message } => {
                eprintln!("mangostudio-runtime: {message}");
                1
            }
        }
    })
}

/// Resolves a bearer credential per [`TokenSource`]: `Stdin` reads one
/// trimmed line, `Env` reads only the environment variable, and the default
/// falls back to `credentials.json`'s `field` when the environment is
/// empty. Never generates one itself — `run_serve` is the only caller that
/// falls through to [`crate::runtime_home::bootstrap_serve_token`] on the
/// default source, mirroring `resolveServeToken`'s own precedence in
/// `cli.ts` (an explicit `stdin`/`env` source that came back empty is
/// refused, never silently upgraded to a freshly generated credential).
fn resolve_token(source: TokenSource, field: &str, env: &impl EnvSource) -> Option<String> {
    match source {
        TokenSource::Stdin => {
            let mut buffer = String::new();
            std::io::stdin().read_to_string(&mut buffer).ok()?;
            let trimmed = buffer.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        }
        TokenSource::Env => {
            let config = RuntimeConfig::from_env(env).ok()?;
            if field == "serveToken" {
                config.serve_token
            } else {
                config.pairing_token
            }
        }
        TokenSource::EnvOrStored => {
            let config = RuntimeConfig::from_env(env).ok()?;
            let from_env = if field == "serveToken" {
                config.serve_token
            } else {
                config.pairing_token
            };
            from_env.or_else(|| {
                let home = config.mango_home;
                let state =
                    crate::runtime_home::read_runtime_slot_credentials(RuntimeSlot::Remote, &home);
                state
                    .stored
                    .as_ref()
                    .and_then(|value| value.get(field))
                    .and_then(|value| value.as_str())
                    .map(str::to_string)
            })
        }
    }
}

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

/// A [`CancellationToken`] cancelled by `SIGINT`/`SIGTERM` (`Ctrl+C` alone
/// on a platform with no `SIGTERM`), spawned as an owned task on the
/// runtime this is called from.
fn install_signal_cancellation() -> CancellationToken {
    let cancel = CancellationToken::new();
    let watcher = cancel.clone();
    tokio::spawn(async move {
        #[cfg(unix)]
        {
            let mut terminate =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("installing a SIGTERM handler cannot fail after the runtime exists");
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = terminate.recv() => {}
            }
        }
        #[cfg(not(unix))]
        {
            let _ = tokio::signal::ctrl_c().await;
        }
        watcher.cancel();
    });
    cancel
}

#[cfg(test)]
mod tests {
    use super::{parse_listen_address, run};
    use crate::config::MapEnv;

    /// A scratch `MANGO_HOME` per test, so `run`'s own disk-touching paths
    /// (`consent_by_invocation`'s auto-grant among them) never read or write
    /// a real user's `~/.mango` — this crate denies `unsafe_code`, so a test
    /// here has no `std::env::set_var` escape hatch even if it wanted one;
    /// [`super::run`] takes an [`crate::config::EnvSource`] for exactly this
    /// reason.
    fn scratch_env(name: &str) -> MapEnv {
        let home = std::env::temp_dir().join(format!(
            "mango-cli-test-{name}-{}-{}",
            std::process::id(),
            line!()
        ));
        MapEnv::from([("MANGO_HOME", home.to_str().unwrap())])
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
    fn a_blank_value_is_rejected() {
        assert!(parse_listen_address("   ").is_none());
    }

    #[test]
    fn an_out_of_range_port_is_rejected() {
        assert!(parse_listen_address("99999").is_none());
    }

    #[test]
    fn version_and_help_still_exit_zero() {
        let env = scratch_env("version-help");
        assert_eq!(run(&["--version".to_string()], &env), 0);
        assert_eq!(run(&["--help".to_string()], &env), 0);
        assert_eq!(run(&[], &env), 0);
    }

    #[test]
    fn an_unrecognised_top_level_command_exits_one() {
        let env = scratch_env("unrecognised");
        assert_eq!(run(&["--not-a-real-flag".to_string()], &env), 1);
    }

    #[test]
    fn setup_without_a_profile_exits_one() {
        let env = scratch_env("setup-no-profile");
        assert_eq!(run(&["setup".to_string()], &env), 1);
    }

    #[test]
    fn setup_with_an_invalid_profile_exits_one() {
        let env = scratch_env("setup-invalid-profile");
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
        let env = scratch_env("setup-valid-profile");
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
        let env = scratch_env("serve-no-listen");
        assert_eq!(run(&["serve".to_string()], &env), 1);
    }

    #[test]
    fn connect_with_no_hub_url_and_nothing_stored_exits_one() {
        let env = scratch_env("connect-no-hub");
        assert_eq!(run(&["connect".to_string()], &env), 1);
    }

    /// A `remote` slot an installer armed to `pending` refuses `connect`
    /// even though a hub URL and a token are both supplied — the
    /// setup-pending gate runs before either is even asked for.
    #[test]
    fn connect_refuses_a_slot_armed_pending_even_with_a_hub_and_token() {
        let env = scratch_env("connect-pending");
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
}
