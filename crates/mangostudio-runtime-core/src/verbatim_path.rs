//! The Win32 spelling of a verbatim (`\\?\`) path.

/// The Win32 spelling of a verbatim drive or UNC path, or `None` for any
/// other path (including verbatim forms with no Win32 equivalent, such as a
/// volume GUID). A text rule, the same on every host; callers that only
/// mean it on Windows gate it.
///
/// It sits below `library` and [`crate::subprocess`] because the library host
/// reports canonical paths the way the TypeScript host does and the PowerShell
/// launcher hands a script path to `-File`; both need the same rule.
///
/// # Example
///
/// ```
/// use mangostudio_runtime_core::verbatim_path::simplify_verbatim;
///
/// assert_eq!(simplify_verbatim(r"\\?\C:\tools").as_deref(), Some(r"C:\tools"));
/// ```
#[must_use]
pub fn simplify_verbatim(path: &str) -> Option<String> {
    let rest = path.strip_prefix(r"\\?\")?;
    if let Some(unc) = rest.strip_prefix(r"UNC\") {
        return Some(format!(r"\\{unc}"));
    }
    let bytes = rest.as_bytes();
    let drive =
        bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\';
    drive.then(|| rest.to_string())
}

#[cfg(test)]
mod tests {
    use super::simplify_verbatim;

    #[test]
    fn verbatim_drive_and_unc_paths_simplify_to_win32_spellings() {
        assert_eq!(
            simplify_verbatim(r"\\?\C:\Users\u").as_deref(),
            Some(r"C:\Users\u")
        );
        assert_eq!(
            simplify_verbatim(r"\\?\UNC\srv\share\x").as_deref(),
            Some(r"\\srv\share\x")
        );
        assert_eq!(simplify_verbatim(r"\\?\Volume{abc}\x"), None);
        // A verbatim path is only a drive path with a letter, a colon, and a separator.
        assert_eq!(simplify_verbatim(r"\\?\ab\c"), None);
        assert_eq!(simplify_verbatim(r"\\?\a:b"), None);
        assert_eq!(simplify_verbatim(r"C:\Users\u"), None);
        assert_eq!(simplify_verbatim("/home/u"), None);
    }
}
