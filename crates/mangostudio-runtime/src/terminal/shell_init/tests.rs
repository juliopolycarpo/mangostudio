use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;

use mangostudio_runtime_contract::manifest::RuntimeShellKind;

use super::{Launch, ShellInit, plan, posix_quote, powershell_pin_script};
use crate::test_support::ScratchDir;

const PINNED: &str = "/pinned/node/bin";
const EVIL: &str = "/evil/bin";

fn launch<'a>(
    shell: RuntimeShellKind,
    login: bool,
    pinned: &'a [String],
    scratch_parent: &'a Path,
) -> Launch<'a> {
    Launch {
        shell,
        login,
        windows: false,
        pinned,
        path_separator: ":",
        original_zdotdir: None,
        scratch_parent,
    }
}

fn pinned() -> Vec<String> {
    vec![PINNED.to_owned(), "/pinned/bun/bin".to_owned()]
}

/// A real shell on `PATH`, or `None` so the caller can skip a host without it.
fn find_shell(name: &str) -> Option<PathBuf> {
    // The shims are POSIX-shell files for a Unix host; a Windows bash is not what they target.
    if !cfg!(unix) {
        return None;
    }
    // Fixed locations rather than a PATH read, which the config boundary test restricts.
    ["/usr/bin", "/bin", "/usr/local/bin", "/opt/homebrew/bin"]
        .iter()
        .map(|dir| Path::new(dir).join(name))
        .find(|candidate| candidate.is_file())
}

/// Runs `shell` the way a terminal would (interactive, shim args and env), but non-PTY and with
/// one `-c` command, and returns what the command printed.
fn run_shell(
    shell: &Path,
    init: &ShellInit,
    home: &Path,
    extra_env: &[(&str, &str)],
    command: &str,
) -> String {
    let mut process = Command::new(shell);
    process
        .args(&init.args)
        .args(["-i", "-c", command])
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", home)
        .env("INSIDE_EMACS", "") // keeps zsh from probing the terminal
        .envs(init.env.iter().map(|(key, value)| (key, value)))
        .envs(extra_env.iter().copied());
    let output = process.output().expect("expected the shell to start");
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn print_path() -> &'static str {
    "printf '%s' \"$PATH\""
}

fn assert_pinned_first(path: &str, label: &str) {
    let expected = format!("{PINNED}:/pinned/bun/bin:");
    assert!(
        path.starts_with(&expected),
        "{label}: expected PATH to start with {expected:?} after the profile ran | received {path:?}"
    );
    assert!(
        path.contains(EVIL),
        "{label}: expected the profile's own PATH change to survive behind the pin | received {path:?}"
    );
}

#[test]
fn bash_profile_that_rewrites_path_does_not_displace_the_pin() {
    let Some(bash) = find_shell("bash") else {
        eprintln!("skipped: no bash on PATH");
        return;
    };
    let scratch = ScratchDir::created("shell-init-bash");
    let home = scratch.join("home");
    std::fs::create_dir(&home).unwrap();
    std::fs::write(home.join(".bashrc"), format!("export PATH={EVIL}:$PATH\n")).unwrap();
    let pins = pinned();
    let init = plan(&launch(RuntimeShellKind::Bash, false, &pins, &scratch)).expect("a bash shim");
    let path = run_shell(&bash, &init, &home, &[], print_path());
    assert_pinned_first(&path, "bash interactive");
}

#[test]
fn bash_login_shim_reads_the_first_login_profile_like_bash_l() {
    let Some(bash) = find_shell("bash") else {
        eprintln!("skipped: no bash on PATH");
        return;
    };
    let scratch = ScratchDir::created("shell-init-bash-login");
    let home = scratch.join("home");
    std::fs::create_dir(&home).unwrap();
    std::fs::write(
        home.join(".bash_profile"),
        format!("export PATH={EVIL}:$PATH\nexport FROM_BASH_PROFILE=1\n"),
    )
    .unwrap();
    // bash -l stops at .bash_profile, so these two must not run.
    std::fs::write(home.join(".bash_login"), "export FROM_BASH_LOGIN=1\n").unwrap();
    std::fs::write(home.join(".profile"), "export FROM_PROFILE=1\n").unwrap();
    // A plain interactive bash reads .bashrc, a login one only if the profile sources it.
    std::fs::write(home.join(".bashrc"), "export FROM_BASHRC=1\n").unwrap();
    let pins = pinned();
    let init = plan(&launch(RuntimeShellKind::Bash, true, &pins, &scratch)).expect("a bash shim");
    let out = run_shell(
        &bash,
        &init,
        &home,
        &[],
        "printf '%s|%s|%s|%s|%s' \"$PATH\" \"$FROM_BASH_PROFILE\" \"$FROM_BASH_LOGIN\" \"$FROM_PROFILE\" \"$FROM_BASHRC\"",
    );
    let fields: Vec<&str> = out.split('|').collect();
    assert_pinned_first(fields[0], "bash login");
    assert_eq!(
        fields[1..],
        ["1", "", "", ""],
        "expected only .bash_profile to run for a login launch | received {out:?}"
    );
}

#[test]
fn zsh_profile_that_rewrites_path_does_not_displace_the_pin() {
    let Some(zsh) = find_shell("zsh") else {
        eprintln!("skipped: no zsh on PATH");
        return;
    };
    let scratch = ScratchDir::created("shell-init-zsh");
    let home = scratch.join("home");
    std::fs::create_dir(&home).unwrap();
    std::fs::write(home.join(".zshrc"), format!("export PATH={EVIL}:$PATH\n")).unwrap();
    let pins = pinned();
    let init = plan(&launch(RuntimeShellKind::Zsh, false, &pins, &scratch)).expect("a zsh shim");
    let out = run_shell(
        &zsh,
        &init,
        &home,
        &[],
        "printf '%s|%s' \"$PATH\" \"${ZDOTDIR-unset}\"",
    );
    let (path, zdotdir) = out.split_once('|').expect("expected PATH|ZDOTDIR output");
    assert_pinned_first(path, "zsh interactive");
    assert_eq!(
        zdotdir, "unset",
        "expected ZDOTDIR handed back unset to the user's session | received {zdotdir:?}"
    );
}

#[test]
fn zsh_login_shim_runs_every_user_file_in_order_and_pins_after_the_last() {
    let Some(zsh) = find_shell("zsh") else {
        eprintln!("skipped: no zsh on PATH");
        return;
    };
    let scratch = ScratchDir::created("shell-init-zsh-login");
    let home = scratch.join("home");
    std::fs::create_dir(&home).unwrap();
    for (file, step) in [
        (".zshenv", "env"),
        (".zprofile", "profile"),
        (".zshrc", "rc"),
        (".zlogin", "login"),
    ] {
        let rewrite = if file == ".zlogin" {
            format!("export PATH={EVIL}:$PATH\n")
        } else {
            String::new()
        };
        std::fs::write(
            home.join(file),
            format!("STEPS=\"${{STEPS}}{step},\"\n{rewrite}"),
        )
        .unwrap();
    }
    let pins = pinned();
    let init = plan(&launch(RuntimeShellKind::Zsh, true, &pins, &scratch)).expect("a zsh shim");
    let out = run_shell(
        &zsh,
        &init,
        &home,
        &[],
        "printf '%s|%s' \"$PATH\" \"$STEPS\"",
    );
    let (path, steps) = out.split_once('|').expect("expected PATH|STEPS output");
    assert_pinned_first(path, "zsh login");
    assert_eq!(
        steps, "env,profile,rc,login,",
        "expected every user startup file once, in zsh order | received {steps:?}"
    );
}

#[test]
fn zsh_shim_follows_a_zdotdir_the_user_zshenv_sets() {
    let Some(zsh) = find_shell("zsh") else {
        eprintln!("skipped: no zsh on PATH");
        return;
    };
    let scratch = ScratchDir::created("shell-init-zsh-zdotdir");
    let home = scratch.join("home");
    let config = scratch.join("config-zsh");
    std::fs::create_dir(&home).unwrap();
    std::fs::create_dir(&config).unwrap();
    std::fs::write(
        home.join(".zshenv"),
        format!("export ZDOTDIR={}\n", config.display()),
    )
    .unwrap();
    std::fs::write(config.join(".zshrc"), format!("export PATH={EVIL}:$PATH\n")).unwrap();
    let pins = pinned();
    let init = plan(&launch(RuntimeShellKind::Zsh, false, &pins, &scratch)).expect("a zsh shim");
    let out = run_shell(
        &zsh,
        &init,
        &home,
        &[],
        "printf '%s|%s' \"$PATH\" \"${ZDOTDIR-unset}\"",
    );
    let (path, zdotdir) = out.split_once('|').expect("expected PATH|ZDOTDIR output");
    assert_pinned_first(path, "zsh with user ZDOTDIR");
    assert_eq!(
        zdotdir,
        config.to_string_lossy(),
        "expected the user's own ZDOTDIR back after startup | received {zdotdir:?}"
    );
}

#[test]
fn a_shell_run_writes_nothing_into_the_user_home() {
    let Some(bash) = find_shell("bash") else {
        eprintln!("skipped: no bash on PATH");
        return;
    };
    let scratch = ScratchDir::created("shell-init-home-clean");
    let home = scratch.join("home");
    std::fs::create_dir(&home).unwrap();
    let pins = pinned();
    let init = plan(&launch(RuntimeShellKind::Bash, false, &pins, &scratch)).unwrap();
    run_shell(&bash, &init, &home, &[], "true");
    let entries: Vec<_> = std::fs::read_dir(&home).unwrap().collect();
    assert!(
        entries.is_empty(),
        "expected an untouched home directory | received {entries:?}"
    );
}

#[test]
fn dropping_the_init_removes_its_shim_directory() {
    let scratch = ScratchDir::created("shell-init-cleanup");
    let pins = pinned();
    for shell in [RuntimeShellKind::Bash, RuntimeShellKind::Zsh] {
        let init = plan(&launch(shell, false, &pins, &scratch)).unwrap();
        let dir = scratch_children(&scratch);
        assert_eq!(
            dir.len(),
            1,
            "expected one shim directory for {shell:?} | received {dir:?}"
        );
        drop(init);
        let left = scratch_children(&scratch);
        assert!(
            left.is_empty(),
            "expected the shim directory gone after drop for {shell:?} | received {left:?}"
        );
    }
}

fn scratch_children(scratch: &Path) -> Vec<OsString> {
    std::fs::read_dir(scratch)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect()
}

#[cfg(unix)]
#[test]
fn the_shim_directory_is_private_to_the_account() {
    use std::os::unix::fs::PermissionsExt;
    let scratch = ScratchDir::created("shell-init-private");
    let pins = pinned();
    let init = plan(&launch(RuntimeShellKind::Bash, false, &pins, &scratch)).unwrap();
    let dir = Path::new(&init.args[1]).parent().unwrap().to_owned();
    let mode = std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
    assert_eq!(
        mode, 0o700,
        "expected mode 0700 on {dir:?} | received {mode:o}"
    );
}

#[test]
fn nothing_is_planned_without_pinned_directories_or_a_usable_scratch_directory() {
    let scratch = ScratchDir::created("shell-init-none");
    assert!(
        plan(&launch(RuntimeShellKind::Bash, false, &[], &scratch)).is_none(),
        "expected no shim without pinned directories"
    );
    let missing = scratch.join("does-not-exist");
    let pins = pinned();
    assert!(
        plan(&launch(RuntimeShellKind::Bash, false, &pins, &missing)).is_none(),
        "expected the plain launch when {missing:?} cannot hold a shim"
    );
}

#[test]
fn a_windows_host_keeps_the_plain_launch_for_posix_shells_only() {
    let scratch = ScratchDir::created("shell-init-windows");
    let pins = vec![r"C:\node".to_owned()];
    for shell in [RuntimeShellKind::Bash, RuntimeShellKind::Zsh] {
        let mut launch = launch(shell, false, &pins, &scratch);
        launch.windows = true;
        assert!(
            plan(&launch).is_none(),
            "expected no shim for {shell:?} on a Windows host"
        );
    }
    let mut launch = launch(RuntimeShellKind::Powershell, false, &pins, &scratch);
    launch.windows = true;
    launch.path_separator = ";";
    let init = plan(&launch).expect("a PowerShell command");
    let args: Vec<_> = init.args.iter().map(|arg| arg.to_string_lossy()).collect();
    assert_eq!(
        args[..3],
        ["-NoLogo", "-NoExit", "-Command"],
        "expected PowerShell to keep its profile and stay open | received {args:?}"
    );
    assert_eq!(args[3], r"$env:PATH = 'C:\node' + ';' + $env:PATH");
    assert!(
        scratch_children(&scratch).is_empty(),
        "PowerShell needs no shim file"
    );
}

#[test]
fn powershell_script_doubles_single_quotes_in_the_pinned_path() {
    let script = powershell_pin_script(&["C:\\Users\\O'Brien\\node".to_owned()], ";");
    assert_eq!(
        script, "$env:PATH = 'C:\\Users\\O''Brien\\node' + ';' + $env:PATH",
        "expected the quote doubled inside the single-quoted literal | received {script:?}"
    );
}

/// The Windows half of the contract: PowerShell runs the command after the profile, so a
/// profile-style PATH rewrite before it leaves the pin in front.
#[cfg(windows)]
#[test]
fn powershell_command_puts_the_pin_back_in_front_of_a_profile_rewrite() {
    let script = powershell_pin_script(&[r"C:\pinned\node".to_owned()], ";");
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command"])
        .arg(format!(
            "$env:PATH = 'C:\\evil;' + $env:PATH; {script}; [Console]::Out.Write($env:PATH)"
        ))
        .output()
        .expect("expected powershell.exe to start");
    let path = String::from_utf8_lossy(&output.stdout);
    assert!(
        path.starts_with(r"C:\pinned\node;C:\evil;"),
        "expected the pin in front of the profile's rewrite | received {path:?}"
    );
}

#[cfg(unix)]
#[test]
fn posix_quote_survives_single_quotes() {
    assert_eq!(posix_quote("it's"), r"'it'\''s'");
    let out = Command::new("sh")
        .args(["-c", &format!("printf %s {}", posix_quote("a b'c$d"))])
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&out.stdout), "a b'c$d");
}
