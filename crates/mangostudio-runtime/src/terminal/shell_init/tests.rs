use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;

use mangostudio_runtime_contract::manifest::RuntimeShellKind;

#[cfg(unix)]
use super::posix_quote;
use super::{Launch, ShellInit, plan, powershell_pin_script};
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
        global_zshenv_files: &[],
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
    let found = ["/usr/bin", "/bin", "/usr/local/bin", "/opt/homebrew/bin"]
        .iter()
        .map(|dir| Path::new(dir).join(name))
        .find(|candidate| candidate.is_file());
    // macOS ships zsh, and these tests are its only coverage of the zsh shim: a missing one
    // there is a broken runner, not a reason to skip.
    assert!(
        found.is_some() || !(cfg!(target_os = "macos") && name == "zsh"),
        "expected zsh in /bin on a macOS host | received none under /usr/bin, /bin, /usr/local/bin, /opt/homebrew/bin"
    );
    found
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
fn a_login_bash_gets_no_shim_so_it_keeps_login_semantics() {
    let scratch = ScratchDir::created("shell-init-bash-login");
    let pins = pinned();
    assert!(
        plan(&launch(RuntimeShellKind::Bash, true, &pins, &scratch)).is_none(),
        "expected no shim for a login bash (--rcfile is ignored there and -l must stay)"
    );
    assert!(
        scratch_children(&scratch).is_empty(),
        "expected no shim directory for a login bash"
    );
}

/// Runs the first-prompt hooks the way zsh would before drawing the prompt (`zsh -i -c` never
/// reaches a prompt), then prints `PATH`, `ZDOTDIR` and the hooks left registered.
const ZSH_AT_FIRST_PROMPT: &str = "for f in $precmd_functions; do $f; done; \
     printf '%s|%s|%s' \"$PATH\" \"${ZDOTDIR-unset}\" \"$precmd_functions\"";

#[test]
fn zsh_profile_that_rewrites_path_loses_to_the_pin_at_the_first_prompt() {
    let Some(zsh) = find_shell("zsh") else {
        eprintln!("skipped: no zsh on PATH");
        return;
    };
    let scratch = ScratchDir::created("shell-init-zsh");
    let home = scratch.join("home");
    std::fs::create_dir(&home).unwrap();
    std::fs::write(home.join(".zshenv"), "export PATH=/env/bin:$PATH\n").unwrap();
    std::fs::write(
        home.join(".zprofile"),
        format!("export PATH={EVIL}:$PATH\n"),
    )
    .unwrap();
    std::fs::write(home.join(".zshrc"), format!("export PATH={EVIL}:$PATH\n")).unwrap();
    let pins = pinned();
    let init = plan(&launch(RuntimeShellKind::Zsh, false, &pins, &scratch)).expect("a zsh shim");
    let before = run_shell(&zsh, &init, &home, &[], "printf '%s' \"$PATH\"");
    assert!(
        before.starts_with(EVIL),
        "expected the profile's rewrite to win until the first prompt | received {before:?}"
    );
    let out = run_shell(&zsh, &init, &home, &[], ZSH_AT_FIRST_PROMPT);
    let fields: Vec<&str> = out.split('|').collect();
    assert_pinned_first(fields[0], "zsh interactive");
    assert_eq!(
        fields[1], "unset",
        "expected the user's session to see no ZDOTDIR | received {out:?}"
    );
    assert_eq!(
        fields[2], "",
        "expected the one-shot hook to remove itself | received {out:?}"
    );
}

#[test]
fn zsh_login_shim_leaves_every_user_file_to_zsh_in_order() {
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
    assert_eq!(
        init.args,
        [OsString::from("-l")],
        "expected a login zsh to keep -l | received {:?}",
        init.args
    );
    let out = run_shell(
        &zsh,
        &init,
        &home,
        &[],
        "for f in $precmd_functions; do $f; done; printf '%s|%s' \"$PATH\" \"$STEPS\"",
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
    let out = run_shell(&zsh, &init, &home, &[], ZSH_AT_FIRST_PROMPT);
    let fields: Vec<&str> = out.split('|').collect();
    assert_pinned_first(fields[0], "zsh with user ZDOTDIR");
    assert_eq!(
        fields[1],
        config.to_string_lossy(),
        "expected the user's own ZDOTDIR after startup | received {out:?}"
    );
}

/// What macOS's `/etc/zshrc` does: derive `HISTFILE` from `$ZDOTDIR`. zsh offers no way to
/// substitute `/etc/zshrc`, so the same expression runs in the first user file zsh reads after
/// `.zshenv`, which sees the same `ZDOTDIR` the global file would.
#[test]
fn startup_files_after_zshenv_see_the_users_zdotdir_not_the_shim() {
    let Some(zsh) = find_shell("zsh") else {
        eprintln!("skipped: no zsh on PATH");
        return;
    };
    let scratch = ScratchDir::created("shell-init-zsh-histfile");
    let home = scratch.join("home");
    let config = scratch.join("config-zsh");
    std::fs::create_dir(&home).unwrap();
    std::fs::create_dir(&config).unwrap();
    let probe = "HISTFILE=\"${ZDOTDIR:-$HOME}/.zsh_history\"\n";
    std::fs::write(home.join(".zshrc"), probe).unwrap();
    std::fs::write(config.join(".zshrc"), probe).unwrap();
    let pins = pinned();

    // No ZDOTDIR of its own: the history lives under the home directory.
    let init = plan(&launch(RuntimeShellKind::Zsh, false, &pins, &scratch)).expect("a zsh shim");
    let histfile = run_shell(&zsh, &init, &home, &[], "printf '%s' \"$HISTFILE\"");
    assert_eq!(
        Path::new(&histfile),
        home.join(".zsh_history"),
        "expected HISTFILE under the user's home, not the shim | received {histfile:?}"
    );

    // A ZDOTDIR from the session environment: the history lives there.
    let mut with_zdotdir = launch(RuntimeShellKind::Zsh, false, &pins, &scratch);
    let config_text = config.to_string_lossy().into_owned();
    with_zdotdir.original_zdotdir = Some(&config_text);
    let init = plan(&with_zdotdir).expect("a zsh shim");
    let histfile = run_shell(&zsh, &init, &home, &[], "printf '%s' \"$HISTFILE\"");
    assert_eq!(
        Path::new(&histfile),
        config.join(".zsh_history"),
        "expected HISTFILE under the session's ZDOTDIR, not the shim | received {histfile:?}"
    );
}

#[test]
fn zsh_shim_directory_holds_only_zshenv_and_nothing_refers_to_it_afterwards() {
    let scratch = ScratchDir::created("shell-init-zsh-files");
    let pins = pinned();
    let init = plan(&launch(RuntimeShellKind::Zsh, false, &pins, &scratch)).expect("a zsh shim");
    let dir = PathBuf::from(&init.env[0].1);
    let names: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(
        names,
        [OsString::from(".zshenv")],
        "expected only .zshenv in the shim directory | received {names:?}"
    );
    let body = std::fs::read_to_string(dir.join(".zshenv")).unwrap();
    assert!(
        !body.contains(dir.to_string_lossy().as_ref()),
        "expected the shim to never mention its own directory | received {body:?}"
    );
}

#[test]
fn a_global_zshenv_that_mentions_zdotdir_keeps_the_plain_zsh_launch() {
    let scratch = ScratchDir::created("shell-init-zsh-global");
    let global_dir = ScratchDir::created("shell-init-zsh-global-etc");
    let moves = global_dir.join("zshenv");
    let quiet = global_dir.join("quiet-zshenv");
    let missing = global_dir.join("absent-zshenv");
    std::fs::write(&moves, "export ZDOTDIR=/etc/zsh-config\n").unwrap();
    std::fs::write(&quiet, "export EDITOR=vi\n").unwrap();
    let pins = pinned();

    let global = [missing.clone(), moves];
    let mut launch_moved = launch(RuntimeShellKind::Zsh, false, &pins, &scratch);
    launch_moved.global_zshenv_files = &global;
    assert!(
        plan(&launch_moved).is_none(),
        "expected no shim when a global zshenv mentions ZDOTDIR"
    );
    assert!(
        scratch_children(&scratch).is_empty(),
        "expected no shim directory for the plain launch"
    );

    let global = [missing, quiet];
    let mut launch_quiet = launch(RuntimeShellKind::Zsh, false, &pins, &scratch);
    launch_quiet.global_zshenv_files = &global;
    assert!(
        plan(&launch_quiet).is_some(),
        "expected the shim when no global zshenv mentions ZDOTDIR"
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
