//! The pure half of `apps/shared/src/environments/detection/winget-ownership.ts`:
//! parsing a captured `winget list` run into an ownership verdict, and
//! marking scanned Node installations winget owns. The `winget list`
//! subprocess call itself is a host adapter's job, not this port's — see
//! this crate's own probing module docs.

use super::binary_scan::normalized_path;
use super::path_env::{dirname_path, join_path};
use super::types::{PathSource, RuntimeInstallation};

/// The only Node package MangoStudio ever asks winget about.
pub const NODE_LTS_WINGET_PACKAGE_ID: &str = "OpenJS.NodeJS.LTS";

/// `winget list` argv for `package_id`, disabling every prompt a host
/// adapter cannot answer.
#[must_use]
pub fn winget_list_argv(package_id: &str) -> Vec<String> {
    vec![
        "list".to_string(),
        "--id".to_string(),
        package_id.to_string(),
        "--exact".to_string(),
        "--accept-source-agreements".to_string(),
        "--disable-interactivity".to_string(),
    ]
}

/// Whether winget owns an installation, as far as `winget list` can say.
///
/// [`WingetOwnership::Unknown`] covers everything the probe could not read
/// cleanly — the binary missing, a timeout, an exit code this parser has
/// never seen — because a shrug must never be read as "not installed" and
/// offer an install winget would refuse.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WingetOwnership {
    /// winget confirmed it owns this package.
    Owned,
    /// winget confirmed it does not.
    NotOwned,
    /// The probe could not tell.
    Unknown,
}

/// `winget list --id <id> --exact` reports "no packages found matching
/// the input criteria" with exit code `0x8A150014` — the one exit code
/// this parser treats as a definite "not installed" rather than a shrug.
/// Windows can surface a child's exit code as the signed 32-bit view
/// (`-1978335212`, what PowerShell's `$LASTEXITCODE` prints) or the
/// unsigned `GetExitCodeProcess` DWORD (`2316632084`) depending on which
/// layer reads it, so both are accepted here via an unsigned-normalizing
/// comparison: truncating a 64-bit exit code to `u32` reproduces the same
/// low 32 bits whichever signedness the caller captured it as.
const WINGET_NO_PACKAGES_EXIT_CODE: u32 = 0x8a15_0014;

fn is_no_packages_exit_code(exit_code: i64) -> bool {
    (exit_code as u32) == WINGET_NO_PACKAGES_EXIT_CODE
}

/// Reads a `winget list` capture into an ownership verdict.
///
/// Column headers are localized (`Nome`/`Name`, `Versão`/`Version`), so
/// "installed" is decided by exit code plus a whitespace-split token match
/// against the id itself — the one cell winget never translates — rather
/// than by anything language-specific. A superstring like
/// `OpenJS.NodeJS.LTS` never satisfies a query for `OpenJS.NodeJS`:
/// matching is by token, not by substring.
///
/// # Example
///
/// ```
/// use mangostudio_runtime::probing::detection::winget_ownership::{parse_winget_list_output, WingetOwnership};
///
/// let stdout = "Nome    ID                Versão  Origem\n-----\nNode.js OpenJS.NodeJS.LTS 24.19.0 winget";
/// assert_eq!(parse_winget_list_output(stdout, Some(0), "OpenJS.NodeJS.LTS"), WingetOwnership::Owned);
/// ```
#[must_use]
pub fn parse_winget_list_output(
    stdout: &str,
    exit_code: Option<i64>,
    package_id: &str,
) -> WingetOwnership {
    let Some(exit_code) = exit_code else {
        return WingetOwnership::Unknown;
    };
    if is_no_packages_exit_code(exit_code) {
        return WingetOwnership::NotOwned;
    }
    if exit_code != 0 {
        return WingetOwnership::Unknown;
    }

    let owned = stdout
        .replace("\r\n", "\n")
        .split('\n')
        .any(|line| line.split_whitespace().any(|token| token == package_id));
    if owned {
        WingetOwnership::Owned
    } else {
        WingetOwnership::NotOwned
    }
}

/// Marks every `system`-attributed Node installation resolved under
/// `%ProgramFiles%\nodejs` as winget-owned, once a live winget probe has
/// confirmed the package id is there.
///
/// Only `system` is overwritten: nvm-windows can point its own
/// `NVM_SYMLINK` at the same directory, and an attribution the scanner
/// already made from a version-manager root or `BUN_INSTALL` outranks a
/// guess from a directory winget merely happens to share. Comparison is
/// case-insensitive and slash-agnostic because a realpath can come back
/// with either separator.
///
/// # Example
///
/// ```
/// use mangostudio_runtime::probing::detection::types::{PathSource, RuntimeInstallation, RuntimeOrigin};
/// use mangostudio_runtime::probing::detection::winget_ownership::mark_winget_owned_node_installations;
///
/// let installation = RuntimeInstallation {
///     path: "C:\\Program Files\\nodejs\\node.exe".to_string(),
///     raw_path: "C:\\Program Files\\nodejs\\node.exe".to_string(),
///     version: Some("24.19.0".to_string()),
///     origin: RuntimeOrigin::Path,
///     path_index: Some(0),
///     effective: true,
///     alias_of: None,
///     managed_by: None,
///     path_source: Some(PathSource::System),
/// };
/// let marked = mark_winget_owned_node_installations(&[installation], Some("C:\\Program Files"));
/// assert_eq!(marked[0].path_source, Some(PathSource::Winget));
/// ```
#[must_use]
pub fn mark_winget_owned_node_installations(
    installations: &[RuntimeInstallation],
    program_files_dir: Option<&str>,
) -> Vec<RuntimeInstallation> {
    let Some(program_files_dir) = program_files_dir
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return installations.to_vec();
    };
    let node_dir = normalized_path(&join_path("win32", &[program_files_dir, "nodejs"]));

    installations
        .iter()
        .map(|installation| {
            if installation.path_source != Some(PathSource::System) {
                return installation.clone();
            }
            if normalized_path(&dirname_path("win32", &installation.path)) != node_dir {
                return installation.clone();
            }
            let mut owned = installation.clone();
            owned.path_source = Some(PathSource::Winget);
            owned
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::super::types::RuntimeOrigin;
    use super::*;

    fn installation(path: &str, path_source: Option<PathSource>) -> RuntimeInstallation {
        RuntimeInstallation {
            path: path.to_string(),
            raw_path: path.to_string(),
            version: Some("24.19.0".to_string()),
            origin: RuntimeOrigin::Path,
            path_index: Some(0),
            effective: true,
            alias_of: None,
            managed_by: None,
            path_source,
        }
    }

    #[test]
    fn a_missing_exit_code_is_unknown() {
        assert_eq!(
            parse_winget_list_output("", None, NODE_LTS_WINGET_PACKAGE_ID),
            WingetOwnership::Unknown
        );
    }

    #[test]
    fn an_unrecognized_nonzero_exit_code_is_unknown() {
        assert_eq!(
            parse_winget_list_output("", Some(1), NODE_LTS_WINGET_PACKAGE_ID),
            WingetOwnership::Unknown
        );
    }

    #[test]
    fn the_no_packages_exit_code_is_not_owned_whether_signed_or_unsigned() {
        assert_eq!(
            parse_winget_list_output("", Some(-1_978_335_212), NODE_LTS_WINGET_PACKAGE_ID),
            WingetOwnership::NotOwned
        );
        assert_eq!(
            parse_winget_list_output("", Some(2_316_632_084), NODE_LTS_WINGET_PACKAGE_ID),
            WingetOwnership::NotOwned
        );
    }

    #[test]
    fn a_zero_exit_code_with_the_package_id_as_a_token_is_owned() {
        let stdout = "Nome    ID                Versão  Origem\r\n-----\r\nNode.js OpenJS.NodeJS.LTS 24.19.0 winget";
        assert_eq!(
            parse_winget_list_output(stdout, Some(0), NODE_LTS_WINGET_PACKAGE_ID),
            WingetOwnership::Owned
        );
    }

    #[test]
    fn a_superstring_id_never_matches_a_shorter_query() {
        let stdout = "Name    ID                Version\n-----\nNode.js OpenJS.NodeJS.LTS 24.19.0";
        assert_eq!(
            parse_winget_list_output(stdout, Some(0), "OpenJS.NodeJS"),
            WingetOwnership::NotOwned
        );
    }

    #[test]
    fn a_zero_exit_code_without_the_package_id_is_not_owned() {
        let stdout = "Name    ID      Version\n-----\nOther.Package 1.0.0";
        assert_eq!(
            parse_winget_list_output(stdout, Some(0), NODE_LTS_WINGET_PACKAGE_ID),
            WingetOwnership::NotOwned
        );
    }

    /// Mutation test 3: replace the unsigned-normalizing comparison with a
    /// plain signed one and the negative-exit-code case goes red. Pre-fix
    /// failure, pasted verbatim from a local run with `exit_code ==
    /// WINGET_NO_PACKAGES_EXIT_CODE as i64` in place of the `as u32`
    /// truncation:
    ///
    /// ```text
    /// thread 'probing::detection::winget_ownership::tests::the_no_packages_exit_code_is_not_owned_whether_signed_or_unsigned' panicked at crates/mangostudio-runtime/src/probing/detection/winget_ownership.rs:...:
    /// assertion `left == right` failed
    ///   left: Unknown
    ///  right: NotOwned
    /// ```
    #[test]
    fn mutation_guard_signed_exit_code_still_normalizes_to_not_owned() {
        assert_eq!(
            parse_winget_list_output("", Some(-1_978_335_212), NODE_LTS_WINGET_PACKAGE_ID),
            WingetOwnership::NotOwned
        );
    }

    #[test]
    fn marks_a_system_node_under_program_files_as_winget_owned() {
        let installations = vec![installation(
            "C:\\Program Files\\nodejs\\node.exe",
            Some(PathSource::System),
        )];
        let marked =
            mark_winget_owned_node_installations(&installations, Some("C:\\Program Files"));
        assert_eq!(marked[0].path_source, Some(PathSource::Winget));
    }

    #[test]
    fn never_overwrites_a_non_system_attribution() {
        let installations = vec![installation(
            "C:\\Program Files\\nodejs\\node.exe",
            Some(PathSource::Nvm),
        )];
        let marked =
            mark_winget_owned_node_installations(&installations, Some("C:\\Program Files"));
        assert_eq!(marked[0].path_source, Some(PathSource::Nvm));
    }

    #[test]
    fn leaves_installations_untouched_without_a_program_files_dir() {
        let installations = vec![installation(
            "C:\\Program Files\\nodejs\\node.exe",
            Some(PathSource::System),
        )];
        let marked = mark_winget_owned_node_installations(&installations, None);
        assert_eq!(marked[0].path_source, Some(PathSource::System));
    }

    #[test]
    fn comparison_is_case_and_slash_insensitive() {
        let installations = vec![installation(
            "c:/program files/nodejs/node.exe",
            Some(PathSource::System),
        )];
        let marked =
            mark_winget_owned_node_installations(&installations, Some("C:\\Program Files"));
        assert_eq!(marked[0].path_source, Some(PathSource::Winget));
    }
}
