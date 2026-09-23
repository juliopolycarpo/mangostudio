//! `String.prototype.localeCompare` with no arguments, as the TypeScript
//! library readers call it.
//!
//! `apps/shared/src/library/machine/instance-reader.ts` sorts a directory
//! resource's leaf files with `localeCompare` — that order is what
//! `library.read-tree` returns and what `whitespaceHash` folds its per-file
//! digests in, so a byte-order sort here would change both on the wire. The
//! TypeScript hosts resolve to ICU's root collation (`en-US` has no
//! tailoring): tertiary strength, punctuation non-ignorable, lowercase
//! before uppercase only as a tie-break. This module is the one place the
//! crate reaches `icu_collator`, so a later swap stays a one-file change.

use std::cmp::Ordering;
use std::sync::OnceLock;

use icu_collator::options::CollatorOptions;
use icu_collator::{Collator, CollatorBorrowed};

fn root_collator() -> &'static CollatorBorrowed<'static> {
    static COLLATOR: OnceLock<CollatorBorrowed<'static>> = OnceLock::new();
    COLLATOR.get_or_init(|| {
        Collator::try_new(Default::default(), CollatorOptions::default())
            .expect("the root collation is compiled into icu_collator's baked data")
    })
}

/// `left.localeCompare(right)` under ICU's root collation.
///
/// # Example
///
/// ```ignore
/// // Case is only a tie-break, so `references/…` sorts before `SKILL.md`.
/// assert_eq!(locale_compare("references/a.md", "SKILL.md"), Ordering::Less);
/// ```
#[must_use]
pub(crate) fn locale_compare(left: &str, right: &str) -> Ordering {
    root_collator().compare(left, right)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn case_and_accents_are_tie_breaks_not_primary_order() {
        let mut names = vec!["SKILL.md", "references/x.md", "b", "B", "a", "é", "e", "f"];
        names.sort_by(|left, right| locale_compare(left, right));
        assert_eq!(
            names,
            ["a", "b", "B", "e", "é", "f", "references/x.md", "SKILL.md"],
            "expected ICU root order (what bun's localeCompare printed) | received {names:?}"
        );
    }
}
