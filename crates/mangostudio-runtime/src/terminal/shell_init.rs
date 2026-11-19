//! Keeps the pinned toolchain in front of `PATH` after the user's own shell startup files ran.
//!
//! The terminal's environment already starts with the selected Node and Bun directories, but a
//! profile that runs `nvm use`, `fnm env` or `volta` rewrites `PATH` afterwards. Each shell gets
//! a small launch shim that runs the user's normal startup and then puts the pinned directories
//! back in front:
//!
//! - bash: `--rcfile <shim>`. `--rcfile` is ignored by a login shell, so a login launch has the
//!   shim read `/etc/profile` and the first of `~/.bash_profile`, `~/.bash_login`, `~/.profile`,
//!   which is what `bash -l` reads.
//! - zsh: `ZDOTDIR=<shim dir>` holds a shim for each startup file. Each one sources the user's
//!   real file from the user's own `ZDOTDIR` (or `$HOME`), and the last file zsh reads for the
//!   launch kind (`.zshrc`, or `.zlogin` for a login shell) re-pins and hands `ZDOTDIR` back.
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
    /// Where the shim directory is created.
    pub scratch_parent: &'a Path,
}

/// Plans the launch that re-pins the toolchain after profile init, or `None` when there is
/// nothing to pin or the shim cannot be written (the terminal then starts the plain way).
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
        RuntimeShellKind::Bash => write_shim(launch, |dir, pin| {
            let rcfile = dir.join("bashrc");
            std::fs::write(&rcfile, bash_rcfile(launch.login, pin))?;
            Ok((
                vec!["--rcfile".into(), rcfile.into_os_string(), "-i".into()],
                Vec::new(),
            ))
        }),
        RuntimeShellKind::Zsh => write_shim(launch, |dir, pin| {
            for (name, body) in zsh_files(dir, launch.original_zdotdir, launch.login, pin) {
                std::fs::write(dir.join(name), body)?;
            }
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

fn bash_rcfile(login: bool, pin: &str) -> String {
    let startup = if login {
        // What `bash -l` reads: the system profile, then the first personal profile that exists.
        "if [ -r /etc/profile ]; then . /etc/profile; fi\n\
         if [ -r \"$HOME/.bash_profile\" ]; then . \"$HOME/.bash_profile\"\n\
         elif [ -r \"$HOME/.bash_login\" ]; then . \"$HOME/.bash_login\"\n\
         elif [ -r \"$HOME/.profile\" ]; then . \"$HOME/.profile\"\n\
         fi\n"
    } else {
        "if [ -r \"$HOME/.bashrc\" ]; then . \"$HOME/.bashrc\"; fi\n"
    };
    format!(
        "# Written by MangoStudio: the usual startup, then the pinned toolchain.\n{startup}{}",
        posix_pin(pin)
    )
}

/// The four zsh startup files, as `(file name, body)`.
fn zsh_files(
    shim_dir: &Path,
    original_zdotdir: Option<&str>,
    login: bool,
    pin: &str,
) -> Vec<(&'static str, String)> {
    let shim = posix_quote(&shim_dir.to_string_lossy());
    let restore_original = match original_zdotdir {
        Some(value) => format!("ZDOTDIR={}\n", posix_quote(value)),
        None => "unset ZDOTDIR\n".to_owned(),
    };
    let last = if login { ".zlogin" } else { ".zshrc" };
    let mut files = vec![(
        ".zshenv",
        format!(
            "# Written by MangoStudio: sources the real .zshenv, then keeps reading from here.\n\
             __mango_shim_dir={shim}\n{restore_original}\
             if [[ -r \"${{ZDOTDIR:-$HOME}}/.zshenv\" ]]; then . \"${{ZDOTDIR:-$HOME}}/.zshenv\"; fi\n\
             __mango_user_zdotdir=${{ZDOTDIR-}}\n\
             ZDOTDIR=$__mango_shim_dir\n"
        ),
    )];
    for name in [".zprofile", ".zshrc", ".zlogin"] {
        let mut body = format!(
            "# Written by MangoStudio: sources the real {name} from the user's ZDOTDIR.\n\
             if [[ -n $__mango_user_zdotdir ]]; then ZDOTDIR=$__mango_user_zdotdir; else unset ZDOTDIR; fi\n\
             if [[ -r \"${{ZDOTDIR:-$HOME}}/{name}\" ]]; then . \"${{ZDOTDIR:-$HOME}}/{name}\"; fi\n\
             __mango_user_zdotdir=${{ZDOTDIR-}}\n"
        );
        if name == last {
            // The user's ZDOTDIR is already back in place; finish with the pin.
            body.push_str(&posix_pin(pin));
            body.push_str("unset __mango_shim_dir __mango_user_zdotdir\n");
        } else {
            body.push_str("ZDOTDIR=$__mango_shim_dir\n");
        }
        files.push((name, body));
    }
    files
}

/// The PowerShell command that prepends the pinned directories to `$env:PATH`.
fn powershell_pin_script(pinned: &[String], separator: &str) -> String {
    let prefix = pinned.join(separator).replace('\'', "''");
    let separator = separator.replace('\'', "''");
    format!("$env:PATH = '{prefix}' + '{separator}' + $env:PATH")
}

#[cfg(test)]
mod tests;
