//! Per-user systemd or launchd operation for a paired remote runtime.

#[cfg(unix)]
use std::fs::{self, OpenOptions};
use std::io;
#[cfg(unix)]
use std::io::Write;
use std::path::Path;
#[cfg(any(unix, windows))]
use std::path::PathBuf;
#[cfg(any(unix, windows))]
use std::process::{Command, Stdio};
#[cfg(any(unix, windows))]
use std::thread;
#[cfg(any(unix, windows))]
use std::time::{Duration, Instant};

use serde_json::Value;
#[cfg(any(unix, windows))]
use serde_json::json;

use super::super::{ServiceAction, ServiceMode};
#[cfg(unix)]
use crate::runtime_home::home_dir;
#[cfg(any(unix, windows))]
use crate::runtime_home::{
    RuntimeSlot, read_runtime_slot_config, read_runtime_slot_credentials, slot_current_binary_path,
};

#[cfg(target_os = "linux")]
const UNIT: &str = "mangostudio-runtime.service";
#[cfg(any(target_os = "macos", all(test, target_os = "linux")))]
const LABEL: &str = "com.mangostudio.runtime";
#[cfg(unix)]
const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

#[cfg(unix)]
trait Exec {
    fn run(&self, program: &str, args: &[&str]) -> io::Result<bool>;
    #[cfg(target_os = "macos")]
    fn capture(&self, program: &str, args: &[&str]) -> io::Result<(bool, String)>;
}

#[cfg(unix)]
struct ProcessExec;

#[cfg(unix)]
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

#[cfg(unix)]
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

#[cfg(any(unix, windows))]
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

#[cfg(any(unix, windows))]
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
    #[cfg(windows)]
    if crate::slot_publish::read_slot_current(&crate::runtime_home::slot_dir(
        RuntimeSlot::Remote,
        home,
    ))?
    .is_none()
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "{} has no valid current version; expected a published runtime shim",
                binary.display()
            ),
        ));
    }
    Ok(binary)
}

#[cfg(any(target_os = "linux", all(test, target_os = "macos")))]
fn quote_systemd_arg(value: &str) -> String {
    // systemd reads `$$` as one literal `$` (and `%%` as one `%`). Rust's
    // `replace` has no JS-style `$$` substitution rule, so write `$$` here.
    let escaped = value.replace('%', "%%").replace('$', "$$");
    if escaped
        .chars()
        .any(|char| char.is_whitespace() || char == '"' || char == '\\')
    {
        format!("\"{}\"", escaped.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        escaped
    }
}

#[cfg(any(target_os = "linux", all(test, target_os = "macos")))]
fn render_systemd(binary: &Path, mode: ServiceMode) -> String {
    format!(
        "[Unit]\nDescription=MangoStudio runtime ({})\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart={} {}\nRestart=on-failure\nRestartSec=5\nKillMode=mixed\nTimeoutStopSec=30s\n\n[Install]\nWantedBy=default.target\n",
        mode.as_str(),
        quote_systemd_arg(&binary.to_string_lossy()),
        mode.as_str()
    )
}

#[cfg(any(target_os = "macos", all(test, target_os = "linux")))]
fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

#[cfg(any(target_os = "macos", all(test, target_os = "linux")))]
fn render_launchd(binary: &Path, mode: ServiceMode) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict><key>Label</key><string>{LABEL}</string><key>ProgramArguments</key><array><string>{}</string><string>{}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ExitTimeOut</key><integer>30</integer></dict></plist>\n",
        xml_escape(&binary.to_string_lossy()),
        mode.as_str()
    )
}

#[cfg(unix)]
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

#[cfg(unix)]
fn require(exec: &impl Exec, program: &str, args: &[&str]) -> io::Result<()> {
    if exec.run(program, args)? {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "{program} {args:?} failed; expected a working per-user service manager"
        )))
    }
}

#[cfg(any(target_os = "macos", all(test, target_os = "linux")))]
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

/// Runs one service verb against systemd on Linux or launchd on macOS.
///
/// Unlike the Windows Scheduled Task path, `stop`, `restart` and `uninstall` do not first wait
/// for an active slot update. The asymmetry is intentional: systemd and launchd send SIGTERM
/// before any kill (systemd waits `TimeoutStopSec=30s`), while `Stop-ScheduledTask` ends the
/// task without a shutdown signal. An update the stop interrupts before its commit leaves only a
/// staged binary, which the next update's `begin` sweeps.
///
/// Usage: `run(ServiceAction::Stop, None, false, &mango_home)`.
#[cfg(unix)]
pub(super) fn run(
    action: ServiceAction,
    mode: Option<ServiceMode>,
    force: bool,
    home: &Path,
) -> io::Result<Value> {
    let account_home = home_dir()?;
    operate(action, mode, force, home, &account_home, &ProcessExec)
}

#[cfg(windows)]
pub(super) fn run(
    action: ServiceAction,
    mode: Option<ServiceMode>,
    force: bool,
    home: &Path,
) -> io::Result<Value> {
    windows::operate(action, mode, force, home, &windows::ProcessExec)
}

#[cfg(windows)]
mod windows {
    use super::*;
    use crate::runtime_home::slot_dir;
    use crate::slot_update_lock::SlotUpdateLock;
    use base64::{Engine as _, engine::general_purpose::STANDARD};

    const TASK: &str = "MangoStudio Runtime";
    const MANAGER_TIMEOUT: Duration = Duration::from_secs(30);
    const UPDATE_SETTLE: Duration = Duration::from_secs(25);
    /// PowerShell startup plus the verbs around the wait, reserved from the budget.
    const VERB_MARGIN: Duration = Duration::from_secs(3);

    /// Executes a PowerShell script without interpolating it into a shell command line.
    /// Usage: `ProcessExec.run("Write-Output 'ready'")`.
    pub(super) trait Exec {
        fn run(&self, script: &str, timeout: Duration) -> io::Result<(bool, String)>;
    }

    pub(super) struct ProcessExec;

    impl Exec for ProcessExec {
        fn run(&self, script: &str, timeout: Duration) -> io::Result<(bool, String)> {
            let encoded = encode_script(script);
            let mut child = Command::new("powershell.exe")
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-EncodedCommand",
                    &encoded,
                ])
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()?;
            let deadline = Instant::now() + timeout;
            loop {
                if child.try_wait()?.is_some() {
                    let output = child.wait_with_output()?;
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    return Ok((
                        output.status.success(),
                        if output.status.success() {
                            stdout.trim()
                        } else {
                            stderr.trim()
                        }
                        .to_owned(),
                    ));
                }
                if Instant::now() >= deadline {
                    child.kill()?;
                    let _ = child.wait();
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        format!("PowerShell Scheduled Task command exceeded {timeout:?}"),
                    ));
                }
                thread::sleep(Duration::from_millis(50));
            }
        }
    }

    fn encode_script(script: &str) -> String {
        let utf16 = script
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>();
        STANDARD.encode(utf16)
    }

    fn ps_quote(text: &str) -> String {
        format!("'{}'", text.replace('\'', "''"))
    }

    fn mode_arg(mode: ServiceMode) -> &'static str {
        match mode {
            ServiceMode::Connect => "connect",
            ServiceMode::Serve => "serve",
        }
    }

    pub(super) fn task_runner(shim: &Path, home: &Path, mode: ServiceMode) -> String {
        format!(
            "$ErrorActionPreference = 'Stop'\n$env:MANGO_HOME = {}\nwhile ($true) {{\n  $global:LASTEXITCODE = $null\n  & {} {}\n  if ($null -eq $LASTEXITCODE) {{ exit 1 }}\n  if ($LASTEXITCODE -ne 75) {{ exit $LASTEXITCODE }}\n  Start-Sleep -Milliseconds 250\n}}",
            ps_quote(&home.to_string_lossy()),
            ps_quote(&shim.to_string_lossy()),
            ps_quote(mode_arg(mode))
        )
    }

    fn task_arguments(shim: &Path, home: &Path, mode: ServiceMode) -> String {
        format!(
            "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand {}",
            encode_script(&task_runner(shim, home, mode))
        )
    }

    pub(super) fn install_script(
        shim: &Path,
        home: &Path,
        mode: ServiceMode,
    ) -> io::Result<String> {
        let args = task_arguments(shim, home, mode);
        if args.len() > 8192 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "Scheduled Task arguments have {} characters; expected at most 8192",
                    args.len()
                ),
            ));
        }
        Ok(format!(
            "$ErrorActionPreference = 'Stop'\n$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()\n$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument {} -WorkingDirectory {}\n$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.User.Value\n$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)\n$principal = New-ScheduledTaskPrincipal -UserId $identity.User.Value -LogonType Interactive -RunLevel Limited\nRegister-ScheduledTask -TaskPath '\\' -TaskName {} -Description 'MangoStudio remote runtime' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null\nStart-ScheduledTask -TaskPath '\\' -TaskName {}",
            ps_quote(&args),
            ps_quote(&shim.parent().unwrap_or(Path::new(".")).to_string_lossy()),
            ps_quote(TASK),
            ps_quote(TASK)
        ))
    }

    fn status_script() -> String {
        format!(
            "$ErrorActionPreference = 'Stop'\n$task = Get-ScheduledTask -TaskPath '\\' -TaskName {} -ErrorAction SilentlyContinue\nif ($null -eq $task) {{ '{{\"installed\":false}}'; exit 0 }}\n$action = @($task.Actions)[0]\n$principal = [string]$task.Principal.UserId\n$principalSid = $null\ntry {{ if ($principal -match '^S-\\d+(?:-\\d+)+$') {{ $principalSid = $principal }} else {{ $principalSid = ([System.Security.Principal.NTAccount]::new($principal)).Translate([System.Security.Principal.SecurityIdentifier]).Value }} }} catch {{}}\n@{{ installed = $true; state = [string]$task.State; enabled = [bool]$task.Settings.Enabled; execute = [string]$action.Execute; arguments = [string]$action.Arguments; principal = $principal; principalSid = $principalSid; currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value }} | ConvertTo-Json -Compress",
            ps_quote(TASK)
        )
    }

    /// Builds one Scheduled Task verb; the stop wait ends `wait` from launch.
    /// Usage: `verb_script(ServiceAction::Restart, false, Duration::from_secs(27))`.
    fn verb_script(action: ServiceAction, force: bool, wait: Duration) -> String {
        let name = ps_quote(TASK);
        let stop = format!(
            "Stop-ScheduledTask -TaskPath '\\' -TaskName {name} -ErrorAction SilentlyContinue"
        );
        let wait_ms = wait.as_millis();
        let wait = format!(
            "$deadline = (Get-Date).AddMilliseconds({wait_ms})\nwhile (((Get-ScheduledTask -TaskPath '\\' -TaskName {name}).State -eq 'Running') -and ((Get-Date) -lt $deadline)) {{ Start-Sleep -Milliseconds 200 }}\nif ((Get-ScheduledTask -TaskPath '\\' -TaskName {name}).State -eq 'Running') {{ throw 'Scheduled Task still running after {wait_ms} ms' }}"
        );
        let start = format!("Start-ScheduledTask -TaskPath '\\' -TaskName {name}");
        let body = match action {
            ServiceAction::Start => start,
            ServiceAction::Stop if force => stop,
            ServiceAction::Stop => format!("{stop}\n{wait}"),
            ServiceAction::Restart => format!("{stop}\n{wait}\n{start}"),
            ServiceAction::Uninstall => format!(
                "{stop}\n{wait}\nUnregister-ScheduledTask -TaskPath '\\' -TaskName {name} -Confirm:$false"
            ),
            _ => unreachable!(),
        };
        format!("$ErrorActionPreference = 'Stop'\n{body}")
    }

    fn require(exec: &impl Exec, script: &str, timeout: Duration, action: &str) -> io::Result<()> {
        let (success, output) = exec.run(script, timeout)?;
        if success {
            Ok(())
        } else {
            Err(io::Error::other(format!(
                "{action} failed for {TASK}; expected a working per-user Scheduled Task manager: {output}"
            )))
        }
    }

    fn settle_update(home: &Path) -> io::Result<SlotUpdateLock> {
        let slot = slot_dir(RuntimeSlot::Remote, home);
        let deadline = Instant::now() + UPDATE_SETTLE;
        loop {
            match SlotUpdateLock::acquire(
                &slot,
                format!(
                    "service-{}-{:?}",
                    std::process::id(),
                    std::thread::current().id()
                ),
                MANAGER_TIMEOUT,
            ) {
                Ok(claim) => return Ok(claim),
                Err(error)
                    if error.kind() == io::ErrorKind::WouldBlock && Instant::now() < deadline =>
                {
                    thread::sleep(Duration::from_millis(100))
                }
                Err(error) => {
                    return Err(io::Error::new(
                        error.kind(),
                        format!(
                            "could not settle active runtime update before service stop: {error}"
                        ),
                    ));
                }
            }
        }
    }

    fn inspect_task_owner(home: &Path, exec: &impl Exec) -> io::Result<()> {
        let status = operate(ServiceAction::Status, None, false, home, exec)?;
        if status["error"]
            .as_str()
            .is_some_and(|error| error.starts_with("Get-ScheduledTask failed"))
        {
            return Err(io::Error::other(format!(
                "could not inspect Scheduled Task {TASK}: {}",
                status["error"]
            )));
        }
        if status["installed"] == true && status["ownerMatchesCurrentUser"] != true {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!(
                    "Scheduled Task {TASK} belongs to another user; expected the current user's task"
                ),
            ));
        }
        Ok(())
    }

    /// Operates the current user's root Scheduled Task. Usage: `operate(ServiceAction::Status, None, false, home, &ProcessExec)`.
    pub(super) fn operate(
        action: ServiceAction,
        mode: Option<ServiceMode>,
        force: bool,
        home: &Path,
        exec: &impl Exec,
    ) -> io::Result<Value> {
        let deadline = Instant::now() + MANAGER_TIMEOUT;
        let shim = slot_current_binary_path(RuntimeSlot::Remote, home);
        match action {
            ServiceAction::Install => {
                let mode = configured_mode(mode, home)?;
                let shim = check_install(mode, home)?;
                inspect_task_owner(home, exec)?;
                require(
                    exec,
                    &install_script(&shim, home, mode)?,
                    MANAGER_TIMEOUT,
                    "Register-ScheduledTask",
                )?;
            }
            ServiceAction::Status => {
                let (ok, output) = exec.run(&status_script(), MANAGER_TIMEOUT)?;
                if !ok {
                    return Ok(
                        json!({"schemaVersion":1,"platform":"win32","unitName":TASK,"installed":false,"enabled":false,"running":false,"error":format!("Get-ScheduledTask failed: {output}")}),
                    );
                }
                let task: Value = serde_json::from_str(&output).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, format!("Get-ScheduledTask returned {output:?}; expected JSON task status: {error}")))?;
                let installed = task["installed"] == true;
                let owner_matches =
                    installed && task["principalSid"].as_str() == task["currentSid"].as_str();
                let args = task["arguments"].as_str().unwrap_or_default();
                let exec_uses_current = installed
                    && task["execute"]
                        .as_str()
                        .and_then(|value| Path::new(value).file_name())
                        .is_some_and(|value| {
                            value
                                .to_string_lossy()
                                .eq_ignore_ascii_case("powershell.exe")
                        })
                    && [ServiceMode::Connect, ServiceMode::Serve]
                        .iter()
                        .any(|mode| args == task_arguments(&shim, home, *mode));
                let current =
                    crate::slot_publish::read_slot_current(&slot_dir(RuntimeSlot::Remote, home));
                let current_binary_present = current.is_ok_and(|version| version.is_some());
                let error = if installed && !owner_matches {
                    Some(format!(
                        "Scheduled Task {TASK} principal {:?} could not be verified as the current user's SID",
                        task["principal"].as_str().unwrap_or_default()
                    ))
                } else if installed && !exec_uses_current {
                    Some(format!(
                        "Scheduled Task {TASK} action does not launch the current remote runtime shim"
                    ))
                } else {
                    None
                };
                let mut status = json!({"schemaVersion":1,"platform":"win32","unitName":TASK,"installed":installed,"enabled":installed && task["enabled"] == true,"running":installed && task["state"] == "Running","execUsesCurrent":exec_uses_current,"currentBinaryPresent":current_binary_present,"ownerMatchesCurrentUser":owner_matches,"manager":{"label":TASK,"activeState":task["state"],"taskPath":"\\"}});
                if let Some(error) = error {
                    status["error"] = json!(error);
                }
                return Ok(status);
            }
            ServiceAction::Uninstall | ServiceAction::Stop | ServiceAction::Restart => {
                inspect_task_owner(home, exec)?;
                let _claim = if force {
                    None
                } else {
                    Some(settle_update(home)?)
                };
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining <= VERB_MARGIN {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        format!(
                            "runtime update left {remaining:?} of the 30-second service stop cap; expected more than {VERB_MARGIN:?} to stop the task"
                        ),
                    ));
                }
                require(
                    exec,
                    &verb_script(action, force, remaining - VERB_MARGIN),
                    remaining,
                    "Scheduled Task service action",
                )?;
            }
            ServiceAction::Start => {
                inspect_task_owner(home, exec)?;
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "Scheduled Task inspection exceeded the 30-second service start cap",
                    ));
                }
                require(
                    exec,
                    &verb_script(action, force, Duration::ZERO),
                    remaining,
                    "Start-ScheduledTask",
                )?;
            }
        }
        Ok(json!({"ok":true}))
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::windows::{Exec, operate};
    use super::*;
    use crate::test_support::scratch_dir;
    use std::sync::Mutex;

    struct FakeTaskExec {
        calls: Mutex<Vec<String>>,
        timeouts: Mutex<Vec<Duration>>,
        output: String,
    }

    impl Exec for FakeTaskExec {
        fn run(&self, script: &str, timeout: Duration) -> io::Result<(bool, String)> {
            self.calls.lock().unwrap().push(script.to_owned());
            self.timeouts.lock().unwrap().push(timeout);
            Ok((true, self.output.clone()))
        }
    }

    #[test]
    fn status_flags_foreign_task_owner_and_missing_current_shim() {
        let home = scratch_dir("win-service-status");
        let exec = FakeTaskExec {
            calls: Mutex::new(Vec::new()),
            timeouts: Mutex::new(Vec::new()),
            output: r#"{"installed":true,"state":"Ready","enabled":true,"execute":"other.exe","arguments":"stale","principal":"S-1-5-21-1","currentSid":"S-1-5-21-2"}"#.into(),
        };
        let status = operate(ServiceAction::Status, None, false, &home, &exec).unwrap();
        assert_eq!(status["installed"], true);
        assert_eq!(status["running"], false);
        assert_eq!(status["execUsesCurrent"], false);
        assert_eq!(status["currentBinaryPresent"], false);
        assert_eq!(status["ownerMatchesCurrentUser"], false);
        assert!(
            status["error"]
                .as_str()
                .is_some_and(|error| error.contains("could not be verified"))
        );
    }

    #[test]
    fn absent_task_status_omits_optional_error() {
        let home = scratch_dir("win-service-absent");
        let exec = FakeTaskExec {
            calls: Mutex::new(Vec::new()),
            timeouts: Mutex::new(Vec::new()),
            output: r#"{"installed":false}"#.into(),
        };
        let status = operate(ServiceAction::Status, None, false, &home, &exec).unwrap();
        assert_eq!(status["installed"], false);
        assert!(status.get("error").is_none());
    }

    #[test]
    fn status_accepts_a_task_principal_returned_as_an_account_name() {
        let home = scratch_dir("win-service-account-name");
        let exec = FakeTaskExec {
            calls: Mutex::new(Vec::new()),
            timeouts: Mutex::new(Vec::new()),
            output: r#"{"installed":true,"state":"Running","enabled":true,"execute":"powershell.exe","arguments":"stale","principal":"julio","principalSid":"S-1-5-21-1","currentSid":"S-1-5-21-1"}"#.into(),
        };
        let status = operate(ServiceAction::Status, None, false, &home, &exec).unwrap();
        assert_eq!(status["ownerMatchesCurrentUser"], true);
        assert_eq!(status["execUsesCurrent"], false);
    }

    #[test]
    fn mutating_commands_refuse_a_foreign_task_before_running_a_verb() {
        let home = scratch_dir("win-service-foreign-commands");
        for (action, force) in [
            (ServiceAction::Start, false),
            (ServiceAction::Stop, false),
            (ServiceAction::Stop, true),
            (ServiceAction::Restart, false),
            (ServiceAction::Uninstall, false),
        ] {
            let exec = FakeTaskExec {
                calls: Mutex::new(Vec::new()),
                timeouts: Mutex::new(Vec::new()),
                output: r#"{"installed":true,"state":"Running","enabled":true,"execute":"powershell.exe","arguments":"stale","principal":"other","principalSid":"S-1-5-21-1","currentSid":"S-1-5-21-2"}"#.into(),
            };
            let error = operate(action, None, force, &home, &exec).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
            let calls = exec.calls.lock().unwrap();
            assert_eq!(calls.len(), 1);
            assert!(calls[0].contains("Get-ScheduledTask"));
            assert!(!calls[0].contains("Stop-ScheduledTask"));
            assert!(!calls[0].contains("Start-ScheduledTask"));
            assert!(!calls[0].contains("Unregister-ScheduledTask"));
        }
    }

    #[test]
    fn restart_waits_for_installer_claim_and_then_stops_before_starting() {
        let home = scratch_dir("win-service-restart");
        let exec = FakeTaskExec {
            calls: Mutex::new(Vec::new()),
            timeouts: Mutex::new(Vec::new()),
            output: r#"{"installed":true,"state":"Running","enabled":true,"execute":"powershell.exe","arguments":"stale","principal":"julio","principalSid":"S-1-5-21-1","currentSid":"S-1-5-21-1"}"#.into(),
        };
        operate(ServiceAction::Restart, None, false, &home, &exec).unwrap();
        let calls = exec.calls.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert!(calls[0].contains("Get-ScheduledTask"));
        assert!(calls[1].contains("Stop-ScheduledTask"));
        assert!(calls[1].contains("Start-ScheduledTask"));
        assert!(calls[1].find("Stop-ScheduledTask") < calls[1].find("Start-ScheduledTask"));
        assert!(calls[1].contains("AddMilliseconds("));
        assert!(!home.join("runtime/remote/runtime-update.lock").exists());
    }

    #[test]
    fn stop_wait_ends_before_the_budget_left_after_a_slow_update_settles() {
        use crate::slot_update_lock::SlotUpdateLock;
        let home = scratch_dir("win-service-slow-settle");
        let claim = SlotUpdateLock::acquire(
            &crate::runtime_home::slot_dir(RuntimeSlot::Remote, &home),
            "slow-installer".into(),
            Duration::from_secs(30),
        )
        .unwrap();
        let installer = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(1500));
            drop(claim);
        });
        let exec = FakeTaskExec {
            calls: Mutex::new(Vec::new()),
            timeouts: Mutex::new(Vec::new()),
            output: r#"{"installed":true,"state":"Running","enabled":true,"execute":"powershell.exe","arguments":"stale","principal":"julio","principalSid":"S-1-5-21-1","currentSid":"S-1-5-21-1"}"#.into(),
        };
        operate(ServiceAction::Restart, None, false, &home, &exec).unwrap();
        installer.join().unwrap();
        let calls = exec.calls.lock().unwrap();
        let timeout = exec.timeouts.lock().unwrap()[1];
        let wait_in = |unit: &str, scale: u64| {
            calls[1]
                .split_once(&format!("{unit}("))
                .and_then(|(_, rest)| rest.split_once(')'))
                .and_then(|(value, _)| value.parse::<u64>().ok())
                .map(|value| Duration::from_millis(value * scale))
        };
        let wait = wait_in("AddMilliseconds", 1)
            .or_else(|| wait_in("AddSeconds", 1000))
            .unwrap_or_else(|| panic!("expected a stop wait in the verb | received: {}", calls[1]));
        assert!(
            timeout.saturating_sub(wait) >= Duration::from_secs(2),
            "expected the stop wait to end at least 2s before the kill timeout {timeout:?} | received wait: {wait:?}"
        );
    }

    #[test]
    fn encoded_runner_relaunches_on_exit_75_without_exposing_credentials() {
        use super::windows::{install_script, task_runner};
        let shim =
            Path::new(r"C:\Users\O'Brien & Sons\Mango\runtime\remote\mangostudio-runtime.cmd");
        let home = Path::new(r"C:\Users\O'Brien & Sons\Mango");
        let runner = task_runner(shim, home, ServiceMode::Connect);
        assert!(runner.contains("O''Brien & Sons"));
        assert!(runner.contains("$LASTEXITCODE -ne 75"));
        assert!(runner.contains("exit $LASTEXITCODE"));
        assert!(runner.contains("$env:MANGO_HOME"));
        let install = install_script(shim, home, ServiceMode::Connect).unwrap();
        assert!(install.contains("New-ScheduledTaskPrincipal"));
        assert!(install.contains("-LogonType Interactive -RunLevel Limited"));
        assert!(install.contains("-MultipleInstances IgnoreNew"));
        assert!(!install.contains("pairingToken"));
    }
}

#[cfg(not(any(unix, windows)))]
pub(super) fn run(
    _action: ServiceAction,
    _mode: Option<ServiceMode>,
    _force: bool,
    _home: &Path,
) -> io::Result<Value> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "per-user service management requires Linux systemd or macOS launchd",
    ))
}

#[cfg(all(test, not(any(unix, windows))))]
mod unsupported_tests {
    use super::*;

    #[test]
    fn service_operation_reports_unsupported_until_a_native_backend_exists() {
        let error = run(ServiceAction::Status, None, false, Path::new(".")).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::Unsupported);
        assert!(error.to_string().contains("Linux systemd or macOS launchd"));
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[cfg(target_os = "linux")]
    use crate::runtime_home::{write_runtime_slot_config, write_runtime_slot_credentials};
    #[cfg(target_os = "linux")]
    use crate::test_support::scratch_dir;
    use std::sync::Mutex;

    #[cfg(target_os = "linux")]
    struct FakeExec(Mutex<Vec<String>>);
    #[cfg(target_os = "linux")]
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
    fn systemd_unit_escapes_a_dollar_as_exactly_two_dollars() {
        let text = render_systemd(
            Path::new("/tmp/a$b/remote/current/mangostudio-runtime"),
            ServiceMode::Connect,
        );
        assert!(
            text.contains("ExecStart=/tmp/a$$b/remote/current/mangostudio-runtime connect"),
            "expected ExecStart with `$` escaped as `$$`; received unit:\n{text}"
        );
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
        let slot = home.join("runtime/remote");
        let config = fs::read(slot.join("runtime.json")).unwrap();
        let credentials = fs::read(slot.join("credentials.json")).unwrap();
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
        let lifecycle_start = fake.0.lock().unwrap().len();

        let status = operate(ServiceAction::Status, None, false, &home, &home, &fake).unwrap();
        for field in [
            "installed",
            "enabled",
            "running",
            "execUsesCurrent",
            "currentBinaryPresent",
        ] {
            assert_eq!(status[field], true, "service status {field}");
        }
        for action in [
            ServiceAction::Start,
            ServiceAction::Restart,
            ServiceAction::Stop,
            ServiceAction::Uninstall,
        ] {
            operate(action, None, false, &home, &home, &fake).unwrap();
        }
        assert!(!unit_path(&home).exists());
        assert_eq!(fs::read(slot.join("runtime.json")).unwrap(), config);
        assert_eq!(
            fs::read(slot.join("credentials.json")).unwrap(),
            credentials
        );
        assert_eq!(
            &fake.0.lock().unwrap()[lifecycle_start..],
            [
                "systemctl --user show-environment",
                "systemctl --user is-enabled mangostudio-runtime.service",
                "systemctl --user is-active mangostudio-runtime.service",
                "systemctl --user start mangostudio-runtime.service",
                "systemctl --user --no-block restart mangostudio-runtime.service",
                "systemctl --user stop mangostudio-runtime.service",
                "systemctl --user disable mangostudio-runtime.service",
                "systemctl --user --no-block stop mangostudio-runtime.service",
                "systemctl --user daemon-reload",
            ]
        );
    }
    /// A remote slot with setup answered, `config` merged into
    /// `runtime.json`, `credentials` stored, and (when `publish`) a binary
    /// published through `current`.
    #[cfg(target_os = "linux")]
    fn configured_home(
        name: &str,
        config: &[(&str, Option<Value>)],
        credentials: &[(&str, Option<Value>)],
        publish: bool,
    ) -> crate::test_support::ScratchDir {
        let home = scratch_dir(name);
        fs::create_dir_all(&*home).unwrap();
        let mut update = vec![("setup", Some(json!({"state":"configured","by":"cli"})))];
        update.extend_from_slice(config);
        write_runtime_slot_config(RuntimeSlot::Remote, &home, &update).unwrap();
        if !credentials.is_empty() {
            write_runtime_slot_credentials(RuntimeSlot::Remote, &home, credentials).unwrap();
        }
        if publish {
            let source = home.join("downloaded-runtime");
            fs::write(&source, b"runtime bytes").unwrap();
            super::super::install_source(&source, RuntimeSlot::Remote, "1.2.3", &home).unwrap();
        }
        home
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn reinstalling_rewrites_the_unit_and_re_enables_it() {
        let home = configured_home(
            "service-reinstall",
            &[
                ("hubUrl", Some(json!("wss://hub.example"))),
                ("serveListen", Some(json!("0.0.0.0:8787"))),
            ],
            &[
                ("pairingToken", Some(json!("pairing"))),
                ("serveToken", Some(json!("serving"))),
            ],
            true,
        );
        let fake = FakeExec(Mutex::new(Vec::new()));
        operate(
            ServiceAction::Install,
            Some(ServiceMode::Connect),
            false,
            &home,
            &home,
            &fake,
        )
        .unwrap();
        operate(
            ServiceAction::Install,
            Some(ServiceMode::Serve),
            false,
            &home,
            &home,
            &fake,
        )
        .unwrap();

        let body = fs::read_to_string(unit_path(&home)).unwrap();
        assert!(
            body.contains("/current/mangostudio-runtime serve\n"),
            "expected the rewritten unit to run serve | received:\n{body}"
        );
        let enables = fake
            .0
            .lock()
            .unwrap()
            .iter()
            .filter(|call| {
                call.as_str() == "systemctl --user enable --now mangostudio-runtime.service"
            })
            .count();
        assert!(
            enables == 2,
            "expected enable calls: 2 | received: {enables}"
        );
    }

    /// Fails exactly the calls whose arguments include `failing`.
    #[cfg(target_os = "linux")]
    struct FailingVerbExec {
        failing: &'static str,
        calls: Mutex<Vec<String>>,
    }
    #[cfg(target_os = "linux")]
    impl Exec for FailingVerbExec {
        fn run(&self, program: &str, args: &[&str]) -> io::Result<bool> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("{program} {}", args.join(" ")));
            Ok(!args.contains(&self.failing))
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn install_reports_a_failed_enable() {
        let home = configured_home(
            "service-enable-failure",
            &[("hubUrl", Some(json!("wss://hub.example")))],
            &[("pairingToken", Some(json!("pairing")))],
            true,
        );
        let exec = FailingVerbExec {
            failing: "enable",
            calls: Mutex::new(Vec::new()),
        };
        let error = operate(ServiceAction::Install, None, false, &home, &home, &exec)
            .expect_err("a failed enable must fail the install");
        assert!(
            error.to_string().contains("enable"),
            "expected an error naming enable | received: {error}"
        );
        let calls = exec.calls.lock().unwrap();
        assert!(
            calls.last().map(String::as_str)
                == Some("systemctl --user enable --now mangostudio-runtime.service"),
            "expected the install to stop at enable | received: {calls:?}"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn install_refuses_a_missing_current_binary_before_any_manager_call() {
        let home = configured_home(
            "service-binary-missing",
            &[("hubUrl", Some(json!("wss://hub.example")))],
            &[("pairingToken", Some(json!("pairing")))],
            false,
        );
        let fake = FakeExec(Mutex::new(Vec::new()));
        let error = operate(ServiceAction::Install, None, false, &home, &home, &fake)
            .expect_err("no binary through current must refuse the install");
        assert!(
            error.kind() == io::ErrorKind::NotFound
                && error.to_string().contains("install --slot remote"),
            "expected NotFound naming `install --slot remote` | received: {:?} {error}",
            error.kind()
        );
        assert!(
            !unit_path(&home).exists(),
            "expected no unit written | received: one"
        );
        let calls = fake.0.lock().unwrap();
        assert!(
            calls.is_empty(),
            "expected no manager calls | received: {calls:?}"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn install_with_neither_mode_configured_names_both() {
        let home = configured_home("service-neither-mode", &[], &[], false);
        let error = configured_mode(None, &home).expect_err("no mode is configured");
        assert!(
            error.kind() == io::ErrorKind::InvalidInput
                && error
                    .to_string()
                    .contains("neither connect nor serve is configured"),
            "expected InvalidInput naming neither mode | received: {:?} {error}",
            error.kind()
        );
        let both = configured_home(
            "service-both-modes",
            &[
                ("hubUrl", Some(json!("wss://hub.example"))),
                ("serveListen", Some(json!("0.0.0.0:8787"))),
            ],
            &[],
            false,
        );
        let error = configured_mode(None, &both).expect_err("both modes are configured");
        assert!(
            error
                .to_string()
                .contains("expected --mode connect or --mode serve"),
            "expected the refusal to ask for --mode | received: {error}"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn exec_uses_current_is_false_for_a_unit_pointing_at_another_homes_current() {
        let home = configured_home(
            "service-foreign-home",
            &[("hubUrl", Some(json!("wss://hub.example")))],
            &[],
            true,
        );
        let foreign = scratch_dir("service-foreign-home-other");
        let foreign_binary = slot_current_binary_path(RuntimeSlot::Remote, &foreign);
        write_unit(
            &unit_path(&home),
            &render_systemd(&foreign_binary, ServiceMode::Connect),
        )
        .unwrap();
        let fake = FakeExec(Mutex::new(Vec::new()));
        let status = operate(ServiceAction::Status, None, false, &home, &home, &fake).unwrap();
        assert!(
            status["execUsesCurrent"] == false,
            "expected execUsesCurrent: false for another home's current | received: {}",
            status["execUsesCurrent"]
        );
    }
}
