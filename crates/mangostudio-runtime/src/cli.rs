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

use std::io::BufRead as _;
use std::net::{SocketAddr, ToSocketAddrs};
use std::path::PathBuf;

use mangostudio_runtime_contract::manifest::ManifestProfile;
use tokio_util::sync::CancellationToken;

use crate::config::{EnvSource, RuntimeConfig};
use crate::consent::invocation::{consent_by_invocation, setup_command};
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

/// Known ordering gap, inherited from `cli.ts` rather than introduced here:
/// [`consent_by_invocation`] runs (and, on a never-before-answered slot,
/// writes `setup.state = configured, profile: full`) *before* token
/// resolution below can still fail this invocation outright. A `serve` with
/// no token anywhere and nothing stored refuses after already recording the
/// grant — permanently converting a `pending` slot that, in the end, never
/// served anything. `serve.ts`/`connect.ts` order it the same way, so this
/// is a follow-up worth fixing in both hosts together, not a divergence to
/// paper over unilaterally here.
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
    if consent.recorded {
        eprintln!(
            "mangostudio-runtime: recorded full permissions for this machine. Run \"{}\" to \
             narrow them.",
            setup_command(Some(RuntimeSlot::Remote))
        );
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
                "mangostudio-runtime: no serve token. Pipe one in with --token -, or set \
                 MANGOSTUDIO_RUNTIME_SERVE_TOKEN."
            );
            return 1;
        }
    };

    if let Err(error) = write_runtime_slot_config(
        RuntimeSlot::Remote,
        &home,
        &[("serveListen", Some(serde_json::Value::String(raw_listen)))],
    ) {
        eprintln!("mangostudio-runtime: {error}");
        return 1;
    }

    let Ok(runtime) = build_runtime() else {
        eprintln!("mangostudio-runtime: could not start the async runtime.");
        return 1;
    };
    runtime.block_on(async move {
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
        code
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

    // Token resolution runs before consent, not after: on a never-before-
    // answered slot, consent below records `configured`/`profile: full`
    // the instant it runs — permanently, since a later failure never
    // rewinds it. Resolving the token first means a `connect` that goes on
    // to refuse for want of a token never converts a `pending` slot into
    // one that recorded a grant it then failed to use for anything.
    let Some(token) = resolve_token(args.token_source, "pairingToken", env) else {
        eprintln!(
            "mangostudio-runtime: no pairing token. Pipe one in with --token -, or set \
             MANGOSTUDIO_RUNTIME_TOKEN."
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
    if consent.recorded {
        eprintln!(
            "mangostudio-runtime: recorded full permissions for this machine. Run \"{}\" to \
             narrow them.",
            setup_command(Some(RuntimeSlot::Remote))
        );
    }

    if let Err(error) = write_runtime_slot_config(
        RuntimeSlot::Remote,
        &home,
        &[("hubUrl", Some(serde_json::Value::String(hub_url.clone())))],
    ) {
        eprintln!("mangostudio-runtime: {error}");
        return 1;
    }
    match crate::runtime_home::write_runtime_slot_credentials(
        RuntimeSlot::Remote,
        &home,
        &[(
            "pairingToken",
            Some(serde_json::Value::String(token.clone())),
        )],
    ) {
        Ok((_, restricted)) => {
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
    runtime.block_on(async move {
        // See the identical comment in `run_serve`: installed first, always.
        let Ok(signals) = crate::supervisor::ShutdownSignals::install() else {
            eprintln!("mangostudio-runtime: could not install signal handlers.");
            return 1;
        };
        let cancel = CancellationToken::new();
        let signal_task = signals.watch(cancel.clone());

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
                0
            }
            crate::transport::connect::ConnectOutcome::Refused { message } => {
                eprintln!("mangostudio-runtime: {message}");
                // The process is exiting on the hub's refusal, not the
                // signal — `signal_task` may never resolve at all now, so
                // awaiting it here would hang. It is not aborted either:
                // simply dropping the handle detaches it, and the runtime
                // this function's own local `runtime` is about to drop
                // reclaims it the same way process exit reclaims every
                // other resource, never a task this code chose to abandon
                // while it still had something left to do.
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
            // `read_line`, not `read_to_string`: the latter blocks until
            // EOF, which an interactive terminal never sends on its own
            // (a person would have to know to press Ctrl+D) — exactly the
            // hang this doc comment's "one trimmed line" promises not to
            // cause. `read_line` returns as soon as a newline arrives,
            // which is what a piped `echo "$TOKEN" | mangostudio-runtime
            // serve --token stdin` (or a person typing one line and
            // pressing Enter) actually produces.
            let mut buffer = String::new();
            std::io::stdin().lock().read_line(&mut buffer).ok()?;
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
