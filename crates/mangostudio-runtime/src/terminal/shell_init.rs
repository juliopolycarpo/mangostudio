//! Keeps the pinned toolchain in front of `PATH` after the user's own shell startup files ran.
//!
//! The terminal's environment already starts with the selected Node and Bun directories, but a
//! profile that runs `nvm use`, `fnm env` or `volta` rewrites `PATH` afterwards. Where the shell
//! allows it, a small launch shim puts the pinned directories back in front:
//!
//! - bash (non-login, Linux): `--rcfile <shim>` sources `~/.bashrc`, then prepends. This is what
//!   an interactive bash reads anyway (`SYS_BASHRC` aside). A login bash (macOS) gets no shim:
//!   `--rcfile` is ignored by a login shell, and replacing `-l` would lose login semantics
//!   (`login_shell`, the `-bash` `$0`, `logout`, `.bash_logout`). macOS defaults to zsh, so
//!   bash there keeps its own `PATH` order.
//! - zsh: `ZDOTDIR=<shim dir>` holds only a `.zshenv`. It restores the user's original `ZDOTDIR`
//!   (or unsets it) at once, sources the user's own `.zshenv`, and registers a one-shot `precmd`
//!   hook that prepends the pinned directories before the first prompt. Every later startup file
//!   (`/etc/zshrc`, `.zprofile`, `.zshrc`, `.zlogin`) is read by zsh itself from the real
//!   `ZDOTDIR`, so `HISTFILE`, `.zcompdump`, oh-my-zsh and p10k never see the shim, and the hook
//!   runs after every profile `PATH` rewrite. A global `zshenv` that mentions `ZDOTDIR` could
//!   redirect the lookup before the shim is read, so that host keeps the plain launch.
//! - PowerShell: `-NoExit -Command`. PowerShell loads `$PROFILE` before it runs the command, so
//!   the command only has to prepend.
//!
//! Shim files live in a private directory under the OS temp directory, never in the user's home,
//! and are removed with the [`ShellInit`] that owns them.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use mangostudio_runtime_contract::manifest::RuntimeShellKind;

const SHIM_DIR_PREFIX: &str = "mangostudio-shell-";
const SHIM_DIR_ATTEMPTS: usize = 16;

/// The launch arguments and environment that re-pin the toolchain, plus the shim files they use.
#[derive(Debug)]
pub(super) struct ShellInit {
    /// Replaces the shell's default arguments.
    pub args: Vec<OsString>,
    /// Environment entries that point the shell at its shim.
    pub env: Vec<(String, String)>,
    /// Removed on drop; `None` for PowerShell, which needs no file.
    shim_dir: Option<PathBuf>,
}

impl Drop for ShellInit {
    fn drop(&mut self) {
        if let Some(dir) = self.shim_dir.take() {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

/// What a launch needs to know about the host and the shell.
pub(super) struct Launch<'a> {
    pub shell: RuntimeShellKind,
    /// The shell reads login startup files (macOS terminals).
    pub login: bool,
    /// A Windows host: bash and zsh there keep the plain launch, since the pinned directories
    /// are native paths those shells would have to translate.
    pub windows: bool,
    /// The pinned directories, in `PATH` order.
    pub pinned: &'a [String],
    pub path_separator: &'a str,
    /// The `ZDOTDIR` the session would otherwise start with.
    pub original_zdotdir: Option<&'a str>,
    /// Global zsh `zshenv` files; one that mentions `ZDOTDIR` disables the zsh shim.
    pub global_zshenv_files: &'a [PathBuf],
    /// Where the shim directory is created.
    pub scratch_parent: &'a Path,
}

/// Plans the launch that re-pins the toolchain after profile init, or `None` when there is
/// nothing to pin or the shim cannot be written (the terminal then starts the plain way).
/// Where zsh looks for a global `zshenv` (`/etc/zshenv`, or `/etc/zsh/zshenv` on Debian builds).
pub(super) fn default_global_zshenv_files() -> Vec<PathBuf> {
    vec![
        PathBuf::from("/etc/zshenv"),
        PathBuf::from("/etc/zsh/zshenv"),
    ]
}

pub(super) fn plan(launch: &Launch<'_>) -> Option<ShellInit> {
    if launch.pinned.is_empty() {
        return None;
    }
    match launch.shell {
        RuntimeShellKind::Powershell => Some(ShellInit {
            args: vec![
                "-NoLogo".into(),
                "-NoExit".into(),
                "-Command".into(),
                powershell_pin_script(launch.pinned, launch.path_separator).into(),
            ],
            env: Vec::new(),
            shim_dir: None,
        }),
        _ if launch.windows => None,
        // A login bash ignores `--rcfile`; keep `-l` and its semantics instead of a shim.
        RuntimeShellKind::Bash if launch.login => None,
        RuntimeShellKind::Bash => write_shim(launch, |dir, pin| {
            let rcfile = dir.join("bashrc");
            std::fs::write(&rcfile, bash_rcfile(pin))?;
            Ok((
                vec!["--rcfile".into(), rcfile.into_os_string(), "-i".into()],
                Vec::new(),
            ))
        }),
        RuntimeShellKind::Zsh if global_zshenv_mentions_zdotdir(launch.global_zshenv_files) => None,
        RuntimeShellKind::Zsh => write_shim(launch, |dir, pin| {
            std::fs::write(
                dir.join(".zshenv"),
                zshenv_shim(launch.original_zdotdir, pin),
            )?;
            let args = if launch.login {
                vec!["-l".into()]
            } else {
                Vec::new()
            };
            Ok((
                args,
                vec![("ZDOTDIR".to_owned(), dir.to_string_lossy().into_owned())],
            ))
        }),
    }
}

type ShimLaunch = (Vec<OsString>, Vec<(String, String)>);

fn write_shim(
    launch: &Launch<'_>,
    write: impl FnOnce(&Path, &str) -> std::io::Result<ShimLaunch>,
) -> Option<ShellInit> {
    let dir = create_private_dir(launch.scratch_parent).ok()?;
    let pin = launch.pinned.join(launch.path_separator);
    match write(&dir, &pin) {
        Ok((args, env)) => Some(ShellInit {
            args,
            env,
            shim_dir: Some(dir),
        }),
        Err(_) => {
            let _ = std::fs::remove_dir_all(dir);
            None
        }
    }
}

/// `<parent>/mangostudio-shell-<random>`, created fresh (an existing name is never adopted)
/// and readable only by this account.
fn create_private_dir(parent: &Path) -> std::io::Result<PathBuf> {
    for _ in 0..SHIM_DIR_ATTEMPTS {
        let mut random = [0u8; 8];
        getrandom::fill(&mut random).map_err(|error| std::io::Error::other(error.to_string()))?;
        let name: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let candidate = parent.join(format!("{SHIM_DIR_PREFIX}{name}"));
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt as _;
            builder.mode(0o700);
        }
        match builder.create(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        format!(
            "no unused shell shim directory name under {} after {SHIM_DIR_ATTEMPTS} attempts",
            parent.display()
        ),
    ))
}

/// A POSIX single-quoted word: `it's` becomes `'it'\''s'`.
fn posix_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn posix_pin(pin: &str) -> String {
    format!("export PATH={}:\"$PATH\"\n", posix_quote(pin))
}

fn bash_rcfile(pin: &str) -> String {
    format!(
        "# Written by MangoStudio: the usual startup, then the pinned toolchain.\n\
         if [ -r \"$HOME/.bashrc\" ]; then . \"$HOME/.bashrc\"; fi\n{}",
        posix_pin(pin)
    )
}

/// A global `zshenv` that sets or reads `ZDOTDIR` runs before the shim and may move it.
fn global_zshenv_mentions_zdotdir(files: &[PathBuf]) -> bool {
    files.iter().any(|file| {
        std::fs::read(file).is_ok_and(|bytes| String::from_utf8_lossy(&bytes).contains("ZDOTDIR"))
    })
}

/// The shim's only file. It hands `ZDOTDIR` back before anything else can read it, runs the
/// user's `.zshenv`, and leaves a one-shot `precmd` hook to pin the toolchain at the first prompt.
fn zshenv_shim(original_zdotdir: Option<&str>, pin: &str) -> String {
    let restore_original = match original_zdotdir {
        Some(value) => format!("ZDOTDIR={}\n", posix_quote(value)),
        None => "unset ZDOTDIR\n".to_owned(),
    };
    format!(
        "# Written by MangoStudio: restores ZDOTDIR, runs the real .zshenv, pins at the first prompt.\n\
         {restore_original}\
         if [[ -r \"${{ZDOTDIR:-$HOME}}/.zshenv\" ]]; then . \"${{ZDOTDIR:-$HOME}}/.zshenv\"; fi\n\
         __mango_pin_toolchain() {{\n\
         \x20 {pin_command}\
         \x20 precmd_functions=(\"${{(@)precmd_functions:#__mango_pin_toolchain}}\")\n\
         \x20 unfunction __mango_pin_toolchain\n\
         }}\n\
         precmd_functions+=(__mango_pin_toolchain)\n",
        pin_command = posix_pin(pin),
    )
}

/// The PowerShell command that prepends the pinned directories to `$env:PATH`.
fn powershell_pin_script(pinned: &[String], separator: &str) -> String {
    let prefix = pinned.join(separator).replace('\'', "''");
    let separator = separator.replace('\'', "''");
    format!("$env:PATH = '{prefix}' + '{separator}' + $env:PATH")
}

#[cfg(test)]
mod tests;
