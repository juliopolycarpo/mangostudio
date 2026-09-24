//! Per-user systemd or launchd operation for a paired remote runtime.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::super::{ServiceAction, ServiceMode};
use crate::runtime_home::{
    RuntimeSlot, home_dir, read_runtime_slot_config, read_runtime_slot_credentials,
    slot_current_binary_path,
};

const UNIT: &str = "mangostudio-runtime.service";
#[cfg(any(target_os = "macos", test))]
const LABEL: &str = "com.mangostudio.runtime";
const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

trait Exec {
    fn run(&self, program: &str, args: &[&str]) -> io::Result<bool>;
    #[cfg(target_os = "macos")]
    fn capture(&self, program: &str, args: &[&str]) -> io::Result<(bool, String)>;
}

struct ProcessExec;

impl Exec for ProcessExec {
    fn run(&self, program: &str, args: &[&str]) -> io::Result<bool> {
        let mut child = Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
        let deadline = Instant::now() + COMMAND_TIMEOUT;
        loop {
            if let Some(status) = child.try_wait()? {
                return Ok(status.success());
            }
            if Instant::now() >= deadline {
                child.kill()?;
                let _ = child.wait();
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!("{program} {args:?} exceeded 30 seconds"),
                ));
            }
            thread::sleep(Duration::from_millis(50));
        }
    }

    #[cfg(target_os = "macos")]
    fn capture(&self, program: &str, args: &[&str]) -> io::Result<(bool, String)> {
        let mut child = Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let mut stdout = child.stdout.take().expect("stdout was piped");
        let reader = thread::spawn(move || {
            let mut output = String::new();
            use std::io::Read as _;
            stdout.read_to_string(&mut output).map(|_| output)
        });
        let deadline = Instant::now() + COMMAND_TIMEOUT;
        let success = loop {
            if let Some(status) = child.try_wait()? {
                break status.success();
            }
            if Instant::now() >= deadline {
                child.kill()?;
                let _ = child.wait();
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!("{program} {args:?} exceeded 30 seconds"),
                ));
            }
            thread::sleep(Duration::from_millis(50));
        };
        let output = reader
            .join()
            .map_err(|_| io::Error::other("launchctl output reader panicked"))??;
        Ok((success, output))
    }
}

fn unit_path(home: &Path) -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        home.join("Library/LaunchAgents")
            .join(format!("{LABEL}.plist"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        home.join(".config/systemd/user").join(UNIT)
    }
}

fn configured_mode(requested: Option<ServiceMode>, home: &Path) -> io::Result<ServiceMode> {
    let config = read_runtime_slot_config(RuntimeSlot::Remote, home);
    if let Some(error) = config.error {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("remote runtime config is unusable: {error}; run setup --slot remote"),
        ));
    }
    if let Some(mode) = requested {
        return Ok(mode);
    }
    match (
        config.stored_string("hubUrl").is_some(),
        config.stored_string("serveListen").is_some(),
    ) {
        (true, false) => Ok(ServiceMode::Connect),
        (false, true) => Ok(ServiceMode::Serve),
        (true, true) => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "both connect and serve are configured; expected --mode connect or --mode serve",
        )),
        (false, false) => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "neither connect nor serve is configured; expected one configured mode",
        )),
    }
}

fn check_install(mode: ServiceMode, home: &Path) -> io::Result<PathBuf> {
    let config = read_runtime_slot_config(RuntimeSlot::Remote, home);
    if let Some(error) = config.error {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("remote runtime config is unusable: {error}"),
        ));
    }
    if config
        .stored
        .as_ref()
        .and_then(|value| value.pointer("/setup/state"))
        .and_then(Value::as_str)
        != Some("configured")
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "remote runtime setup is pending; run mangostudio-runtime setup --slot remote",
        ));
    }
    let field = match mode {
        ServiceMode::Connect => "hubUrl",
        ServiceMode::Serve => "serveListen",
    };
    if config.stored_string(field).is_none() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{mode:?} is not configured; expected {field} in remote runtime config"),
        ));
    }
    let credentials = read_runtime_slot_credentials(RuntimeSlot::Remote, home);
    if let Some(error) = credentials.error {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("remote credentials are unusable: {error}"),
        ));
    }
    let credential = match mode {
        ServiceMode::Connect => "pairingToken",
        ServiceMode::Serve => "serveToken",
    };
    if credentials.stored_string(credential).is_none() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{mode:?} needs {credential}; run connect or serve once with its token"),
        ));
    }
    let binary = slot_current_binary_path(RuntimeSlot::Remote, home);
    if !binary.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!(
                "no runtime binary at {}; expected mangostudio-runtime install --slot remote first",
                binary.display()
            ),
        ));
    }
    Ok(binary)
}

fn quote_systemd_arg(value: &str) -> String {
    let escaped = value.replace('%', "%%").replace('$', "$$$$");
    if escaped
        .chars()
        .any(|char| char.is_whitespace() || char == '"' || char == '\\')
    {
        format!("\"{}\"", escaped.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        escaped
    }
}

fn render_systemd(binary: &Path, mode: ServiceMode) -> String {
    format!(
        "[Unit]\nDescription=MangoStudio runtime ({})\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart={} {}\nRestart=on-failure\nRestartSec=5\nKillMode=mixed\nTimeoutStopSec=30s\n\n[Install]\nWantedBy=default.target\n",
        mode.as_str(),
        quote_systemd_arg(&binary.to_string_lossy()),
        mode.as_str()
    )
}

#[cfg(any(target_os = "macos", test))]
fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

#[cfg(any(target_os = "macos", test))]
fn render_launchd(binary: &Path, mode: ServiceMode) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict><key>Label</key><string>{LABEL}</string><key>ProgramArguments</key><array><string>{}</string><string>{}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ExitTimeOut</key><integer>30</integer></dict></plist>\n",
        xml_escape(&binary.to_string_lossy()),
        mode.as_str()
    )
}

fn write_unit(path: &Path, body: &str) -> io::Result<()> {
    fs::create_dir_all(path.parent().expect("unit has parent"))?;
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)?;
    file.write_all(body.as_bytes())?;
    file.sync_all()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

fn require(exec: &impl Exec, program: &str, args: &[&str]) -> io::Result<()> {
    if exec.run(program, args)? {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "{program} {args:?} failed; expected a working per-user service manager"
        )))
    }
}

#[cfg(any(target_os = "macos", test))]
fn stop_launchd(exec: &impl Exec, target: &str) -> io::Result<()> {
    if !exec.run("launchctl", &["bootout", target])? && exec.run("launchctl", &["print", target])? {
        return Err(io::Error::other(format!(
            "launchctl bootout failed for {target}; expected the job to leave its domain"
        )));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn operate(
    action: ServiceAction,
    mode: Option<ServiceMode>,
    force: bool,
    home: &Path,
    account_home: &Path,
    exec: &impl Exec,
) -> io::Result<Value> {
    let path = unit_path(account_home);
    let installed = path.is_file();
    match action {
        ServiceAction::Install => {
            let mode = configured_mode(mode, home)?;
            let binary = check_install(mode, home)?;
            require(exec, "systemctl", &["--user", "show-environment"])?;
            write_unit(&path, &render_systemd(&binary, mode))?;
            require(exec, "systemctl", &["--user", "daemon-reload"])?;
            require(exec, "systemctl", &["--user", "enable", "--now", UNIT])?;
            if !exec.run("loginctl", &["enable-linger"]).unwrap_or(false) {
                eprintln!(
                    "mangostudio-runtime: could not enable user lingering; the service may stop at logout"
                );
            }
        }
        ServiceAction::Uninstall => {
            if installed {
                require(exec, "systemctl", &["--user", "disable", UNIT])?;
                require(exec, "systemctl", &["--user", "--no-block", "stop", UNIT])?;
                fs::remove_file(&path)?;
                require(exec, "systemctl", &["--user", "daemon-reload"])?;
            }
        }
        ServiceAction::Status => {
            let bus = exec.run("systemctl", &["--user", "show-environment"]);
            match bus {
                Err(_) => {
                    return Ok(
                        json!({"schemaVersion":1,"platform":"unsupported","unitName":UNIT,"installed":false,"enabled":false,"running":false,"error":"systemd is not available","errorCode":"no-systemd"}),
                    );
                }
                Ok(false) => {
                    return Ok(
                        json!({"schemaVersion":1,"platform":"linux","unitName":UNIT,"installed":false,"enabled":false,"running":false,"error":"no session bus","errorCode":"no-session-bus"}),
                    );
                }
                Ok(true) => {}
            }
            let enabled = installed
                && exec
                    .run("systemctl", &["--user", "is-enabled", UNIT])
                    .unwrap_or(false);
            let running = installed
                && exec
                    .run("systemctl", &["--user", "is-active", UNIT])
                    .unwrap_or(false);
            let current = slot_current_binary_path(RuntimeSlot::Remote, home);
            let body = fs::read_to_string(&path).unwrap_or_default();
            return Ok(
                json!({"schemaVersion":1,"platform":"linux","unitName":UNIT,"installed":installed,"enabled":enabled,"running":running,"execUsesCurrent":body.contains(&quote_systemd_arg(&current.to_string_lossy())),"currentBinaryPresent":current.is_file(),"manager":{"unitPath":path}}),
            );
        }
        ServiceAction::Start => require(exec, "systemctl", &["--user", "start", UNIT])?,
        ServiceAction::Stop if force => {
            require(
                exec,
                "systemctl",
                &["--user", "kill", "--signal=SIGKILL", UNIT],
            )?;
        }
        ServiceAction::Stop => require(exec, "systemctl", &["--user", "stop", UNIT])?,
        ServiceAction::Restart => require(
            exec,
            "systemctl",
            &["--user", "--no-block", "restart", UNIT],
        )?,
    }
    Ok(json!({"ok":true}))
}

#[cfg(target_os = "macos")]
fn operate(
    action: ServiceAction,
    mode: Option<ServiceMode>,
    force: bool,
    home: &Path,
    account_home: &Path,
    exec: &impl Exec,
) -> io::Result<Value> {
    let path = unit_path(account_home);
    let (uid_ok, uid) = exec.capture("id", &["-u"])?;
    let uid = uid.trim();
    if !uid_ok || uid.parse::<u32>().is_err() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("id -u returned {uid:?}; expected a numeric user ID"),
        ));
    }
    let domain = format!("gui/{uid}");
    let target = format!("{domain}/{LABEL}");
    let path_text = path.to_string_lossy();
    match action {
        ServiceAction::Install => {
            let mode = configured_mode(mode, home)?;
            let binary = check_install(mode, home)?;
            write_unit(&path, &render_launchd(&binary, mode))?;
            let _ = exec.run("launchctl", &["bootout", &target]);
            require(exec, "launchctl", &["bootstrap", &domain, &path_text])?;
            require(exec, "launchctl", &["kickstart", "-k", &target])?;
        }
        ServiceAction::Uninstall => {
            stop_launchd(exec, &target)?;
            if path.is_file() {
                fs::remove_file(&path)?;
            }
        }
        ServiceAction::Status => {
            let installed = path.is_file();
            let running = installed
                && exec
                    .capture("launchctl", &["print", &target])
                    .is_ok_and(|(success, output)| success && output.contains("state = running"));
            let current = slot_current_binary_path(RuntimeSlot::Remote, home);
            let body = fs::read_to_string(&path).unwrap_or_default();
            let current_xml = xml_escape(&current.to_string_lossy());
            return Ok(
                json!({"schemaVersion":1,"platform":"darwin","unitName":LABEL,"installed":installed,"enabled":installed,"running":running,"execUsesCurrent":body.contains(&current_xml),"currentBinaryPresent":current.is_file(),"manager":{"unitPath":path}}),
            );
        }
        ServiceAction::Start | ServiceAction::Restart => {
            if !exec.run("launchctl", &["bootstrap", &domain, &path_text])?
                && !exec.run("launchctl", &["print", &target])?
            {
                return Err(io::Error::other(format!(
                    "launchctl bootstrap failed for {target}; expected the job to be loaded"
                )));
            }
            if action == ServiceAction::Restart {
                require(exec, "launchctl", &["kickstart", "-k", &target])?;
            } else {
                require(exec, "launchctl", &["kickstart", &target])?;
            }
        }
        ServiceAction::Stop if force => {
            require(exec, "launchctl", &["kill", "SIGKILL", &target])?;
        }
        ServiceAction::Stop => {
            stop_launchd(exec, &target)?;
        }
    }
    Ok(json!({"ok":true}))
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn operate(
    _action: ServiceAction,
    _mode: Option<ServiceMode>,
    _force: bool,
    _home: &Path,
    _account_home: &Path,
    _exec: &impl Exec,
) -> io::Result<Value> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "per-user service management requires Linux systemd or macOS launchd",
    ))
}

pub(super) fn run(
    action: ServiceAction,
    mode: Option<ServiceMode>,
    force: bool,
    home: &Path,
) -> io::Result<Value> {
    let account_home = home_dir()?;
    operate(action, mode, force, home, &account_home, &ProcessExec)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime_home::{write_runtime_slot_config, write_runtime_slot_credentials};
    use crate::test_support::scratch_dir;
    use std::sync::Mutex;

    struct FakeExec(Mutex<Vec<String>>);
    impl Exec for FakeExec {
        fn run(&self, program: &str, args: &[&str]) -> io::Result<bool> {
            self.0
                .lock()
                .unwrap()
                .push(format!("{program} {}", args.join(" ")));
            Ok(true)
        }

        #[cfg(target_os = "macos")]
        fn capture(&self, program: &str, args: &[&str]) -> io::Result<(bool, String)> {
            self.0
                .lock()
                .unwrap()
                .push(format!("{program} {}", args.join(" ")));
            Ok((
                true,
                if program == "id" {
                    "501"
                } else {
                    "state = running"
                }
                .into(),
            ))
        }
    }

    struct SequenceExec(Mutex<std::collections::VecDeque<bool>>);
    impl Exec for SequenceExec {
        fn run(&self, _program: &str, _args: &[&str]) -> io::Result<bool> {
            Ok(self.0.lock().unwrap().pop_front().unwrap())
        }
        #[cfg(target_os = "macos")]
        fn capture(&self, _program: &str, _args: &[&str]) -> io::Result<(bool, String)> {
            Ok((false, String::new()))
        }
    }

    #[cfg(target_os = "linux")]
    struct NoBusExec;
    #[cfg(target_os = "linux")]
    impl Exec for NoBusExec {
        fn run(&self, _program: &str, _args: &[&str]) -> io::Result<bool> {
            Ok(false)
        }
    }

    #[test]
    fn systemd_unit_names_current_and_thirty_second_stop_cap() {
        let text = render_systemd(
            Path::new("/tmp/remote/current/mangostudio-runtime"),
            ServiceMode::Connect,
        );
        assert!(text.contains("ExecStart=/tmp/remote/current/mangostudio-runtime connect"));
        assert!(text.contains("TimeoutStopSec=30s"));
        assert!(text.contains("KillMode=mixed"));
    }

    #[test]
    fn launchd_plist_names_current_and_thirty_second_stop_cap() {
        let text = render_launchd(
            Path::new("/tmp/mango & co/remote/current/mangostudio-runtime"),
            ServiceMode::Serve,
        );
        assert!(text.contains("/current/mangostudio-runtime"));
        assert!(text.contains("/tmp/mango &amp; co/remote/current"));
        assert!(text.contains("<key>ExitTimeOut</key><integer>30</integer>"));
    }

    #[test]
    fn launchd_stop_reports_a_failed_bootout_when_job_is_still_loaded() {
        let loaded = SequenceExec(Mutex::new([false, true].into()));
        assert!(stop_launchd(&loaded, "gui/501/com.mangostudio.runtime").is_err());
        let absent = SequenceExec(Mutex::new([false, false].into()));
        assert!(stop_launchd(&absent, "gui/501/com.mangostudio.runtime").is_ok());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn restart_is_nonblocking_and_stop_asks_supervisor_once() {
        let home = scratch_dir("service-actions");
        fs::create_dir_all(&*home).unwrap();
        let fake = FakeExec(Mutex::new(Vec::new()));
        operate(ServiceAction::Restart, None, false, &home, &home, &fake).unwrap();
        operate(ServiceAction::Stop, None, false, &home, &home, &fake).unwrap();
        operate(ServiceAction::Stop, None, true, &home, &home, &fake).unwrap();
        assert_eq!(
            *fake.0.lock().unwrap(),
            vec![
                "systemctl --user --no-block restart mangostudio-runtime.service",
                "systemctl --user stop mangostudio-runtime.service",
                "systemctl --user kill --signal=SIGKILL mangostudio-runtime.service"
            ]
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn uninstall_reports_a_manager_failure_before_removing_the_unit() {
        let home = scratch_dir("service-uninstall-failure");
        let path = unit_path(&home);
        write_unit(&path, "[Service]\n").unwrap();
        let failing = SequenceExec(Mutex::new([false].into()));
        let error = operate(
            ServiceAction::Uninstall,
            None,
            false,
            &home,
            &home,
            &failing,
        )
        .unwrap_err();
        assert!(error.to_string().contains("disable"));
        assert!(path.exists());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn install_requires_answered_consent_and_publishes_a_current_unit() {
        let home = scratch_dir("service-install");
        fs::create_dir_all(&home).unwrap();
        let source = home.join("downloaded-runtime");
        fs::write(&source, b"runtime bytes").unwrap();
        super::super::install_source(&source, RuntimeSlot::Remote, "1.2.3", &home).unwrap();
        let fake = FakeExec(Mutex::new(Vec::new()));
        let refused = operate(
            ServiceAction::Install,
            Some(ServiceMode::Connect),
            false,
            &home,
            &home,
            &fake,
        )
        .unwrap_err();
        assert_eq!(refused.kind(), io::ErrorKind::PermissionDenied);
        assert!(!unit_path(&home).exists());

        write_runtime_slot_config(
            RuntimeSlot::Remote,
            &home,
            &[
                ("setup", Some(json!({"state":"configured","by":"cli"}))),
                ("hubUrl", Some(json!("wss://hub.example"))),
            ],
        )
        .unwrap();
        write_runtime_slot_credentials(
            RuntimeSlot::Remote,
            &home,
            &[("pairingToken", Some(json!("stored-token")))],
        )
        .unwrap();
        let no_bus = operate(
            ServiceAction::Install,
            Some(ServiceMode::Connect),
            false,
            &home,
            &home,
            &NoBusExec,
        )
        .unwrap_err();
        assert!(no_bus.to_string().contains("show-environment"));
        assert!(!unit_path(&home).exists());
        operate(
            ServiceAction::Install,
            Some(ServiceMode::Connect),
            false,
            &home,
            &home,
            &fake,
        )
        .unwrap();
        let body = fs::read_to_string(unit_path(&home)).unwrap();
        assert!(body.contains("/current/mangostudio-runtime connect"));
        assert!(!body.contains("stored-token"));
        assert_eq!(
            *fake.0.lock().unwrap(),
            vec![
                "systemctl --user show-environment",
                "systemctl --user daemon-reload",
                "systemctl --user enable --now mangostudio-runtime.service",
                "loginctl enable-linger",
            ]
        );
    }
}
