//! GitHub CLI argument policy, mirroring the TypeScript runtime's allowlists.

use mango_protocol::error::{RemoteError, codes};
use mangostudio_runtime_contract::strings::github_graphql_documents;

const READ: &[&str] = &[
    "auth status",
    "repo view",
    "pr view",
    "pr list",
    "pr status",
    "pr checks",
    "issue list",
    "search prs",
    "api graphql",
];
const WRITE: &[&str] = &["pr create", "pr ready", "pr checkout"];

/// Validates the operation and flags before the GitHub CLI can be launched.
/// Diagnostics deliberately omit rejected operands, which can contain prose.
///
/// # Example
///
/// ```
/// use mangostudio_runtime::commands::gh_policy::validate;
/// assert!(validate(false, &["pr".into(), "list".into()]).is_ok());
/// assert!(validate(false, &["pr".into(), "create".into()]).is_err());
/// ```
pub fn validate(mutate: bool, args: &[String]) -> Result<(), RemoteError> {
    let operation = operation(args)
        .ok_or_else(|| invalid("unrecognized operation", "a supported gh subcommand"))?;
    let allowed = if mutate { WRITE } else { READ };
    if !(allowed.contains(&operation.as_str()) || !mutate && operation == "--version") {
        return Err(invalid(
            "operation outside the method allowlist",
            "a supported operation for this method",
        ));
    }
    for argument in args {
        validate_flag(&operation, argument)?;
    }
    if operation == "api graphql" {
        validate_graphql(&args[2..])?;
    }
    Ok(())
}

fn invalid(reason: &str, expected: &str) -> RemoteError {
    RemoteError::new(
        codes::INTERNAL,
        format!("Invalid gh argv ([redacted]): {reason}; expected {expected}."),
    )
    .with_detail("kind", "tool_argument")
}

fn operation(args: &[String]) -> Option<String> {
    let first = args.first()?;
    if first == "--version" {
        return (args.len() == 1).then(|| first.clone());
    }
    Some(format!("{first} {}", args.get(1)?))
}

fn validate_flag(operation: &str, argument: &str) -> Result<(), RemoteError> {
    let long = argument.split('=').next().unwrap_or(argument);
    if matches!(long, "--show-token" | "--web") {
        return Err(invalid(
            "credential disclosure or desktop side effect",
            "flags confined to this call",
        ));
    }
    let Some(short) = argument.strip_prefix('-') else {
        return Ok(());
    };
    let cluster = short.split('=').next().unwrap_or(short);
    if cluster.is_empty() || !cluster.bytes().all(|letter| letter.is_ascii_alphabetic()) {
        return Ok(());
    }
    if cluster.contains('w') || operation == "auth status" && cluster.contains('t') {
        return Err(invalid(
            "refused short flag",
            "flags that do not reveal tokens or open a browser",
        ));
    }
    Ok(())
}

fn validate_graphql(args: &[String]) -> Result<(), RemoteError> {
    let mut queries = 0;
    for pair in args.chunks(2) {
        let flag = pair[0].as_str();
        if !matches!(flag, "-f" | "--raw-field" | "-F" | "--field") {
            return Err(invalid("unsupported GraphQL flag", "-f/-F field flags"));
        }
        let (key, value) = pair
            .get(1)
            .and_then(|value| value.split_once('='))
            .ok_or_else(|| {
                invalid(
                    "malformed GraphQL field",
                    "a key=value token after each flag",
                )
            })?;
        if value.starts_with('@') {
            return Err(invalid(
                "GraphQL field reads a local file",
                "a literal field value",
            ));
        }
        if key == "query" {
            validate_query(flag, value)?;
            queries += 1;
        }
    }
    if queries != 1 {
        return Err(invalid(
            "missing or duplicate GraphQL query",
            "exactly one pinned -f query= document",
        ));
    }
    Ok(())
}

fn validate_query(flag: &str, value: &str) -> Result<(), RemoteError> {
    if !matches!(flag, "-f" | "--raw-field") {
        return Err(invalid(
            "typed GraphQL query field",
            "a raw -f query= document",
        ));
    }
    let normalized = normalize(value);
    if !github_graphql_documents()
        .iter()
        .any(|pin| normalize(pin) == normalized)
    {
        return Err(invalid(
            "unpinned GraphQL document",
            "a query shipped with this build",
        ));
    }
    Ok(())
}

fn normalize(value: &str) -> String {
    // ECMAScript \s includes BOM but excludes NEL (unlike Rust is_whitespace).
    value
        .split(|c: char| c == '\u{feff}' || c.is_whitespace() && c != '\u{85}')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn read_and_write_operations_stay_separate() {
        for operation in READ {
            let args = argv(&operation.split(' ').collect::<Vec<_>>());
            if *operation != "api graphql" {
                assert!(validate(false, &args).is_ok());
            }
            assert!(validate(true, &args).is_err());
        }
        for operation in WRITE {
            let args = argv(&operation.split(' ').collect::<Vec<_>>());
            assert!(validate(true, &args).is_ok());
            assert!(validate(false, &args).is_err());
        }
        assert!(validate(false, &argv(&["--version"])).is_ok());
        assert!(validate(false, &argv(&["--version", "operand"])).is_err());
        assert!(validate(false, &[]).is_err());
    }

    #[test]
    fn rejects_flag_aliases_without_confusing_titles_or_markdown() {
        for flag in [
            "--show-token",
            "--web=true",
            "-w",
            "-aw",
            "-w=true",
            "-at",
            "-t=true",
        ] {
            assert!(
                validate(false, &argv(&["auth", "status", flag])).is_err(),
                "{flag}"
            );
        }
        assert!(
            validate(
                true,
                &argv(&["pr", "create", "-t", "title", "--body", "- what changed"])
            )
            .is_ok()
        );
    }

    #[test]
    fn pins_queries_and_rejects_file_fields_duplicate_queries_and_other_flags() {
        let query = format!("query={}", github_graphql_documents()[0]);
        let valid = argv(&["api", "graphql", "-f", &query, "-F", "number=1"]);
        assert!(validate(false, &valid).is_ok());
        for suffix in [
            argv(&["-F", "name=@secret"]),
            argv(&["-f", &query]),
            argv(&["--paginate"]),
            argv(&["-f"]),
        ] {
            let mut invalid = valid.clone();
            invalid.extend(suffix);
            assert!(validate(false, &invalid).is_err());
        }
        assert!(validate(false, &argv(&["api", "graphql", "-F", &query])).is_err());
        assert!(
            validate(
                false,
                &argv(&["api", "graphql", "-f", "query=query { viewer { login } }"])
            )
            .is_err()
        );
    }

    #[test]
    fn diagnostics_never_echo_rejected_arguments() {
        let error = validate(false, &argv(&["pr", "private prose"])).unwrap_err();
        assert!(!error.message.contains("private prose"));
        assert_eq!(error.details.unwrap()["kind"], "tool_argument");
    }

    #[test]
    fn normalization_matches_javascript_whitespace() {
        assert_eq!(normalize("\u{feff}query\n\t { x }  "), "query { x }");
        assert_eq!(normalize("query\u{85}{ x }"), "query\u{85}{ x }");
    }
}
