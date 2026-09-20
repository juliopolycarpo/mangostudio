//! The behavioural equality gate between this crate's `jsonschema` validators
//! and TypeBox's.
//!
//! `catalog.json` proves both sides read the same JSON Schema text — true by
//! construction, since [`mangostudio_runtime_contract::catalog`] embeds the
//! file rather than copying it — and proves nothing about whether this
//! crate's validators agree with TypeBox's own reading of that text. This
//! test derives its inventory from the parsed catalog and asserts every
//! fixture in `generated/conformance-corpus.json` — one valid seed and a
//! bounded set of mechanical mutations per method params/result and topic
//! payload, each carrying the verdict TypeBox itself gave it at emit time —
//! gets the same verdict from this crate's validators.
//!
//! `scripts/runtime-contract/corpus.ts` builds the corpus; `bun run
//! contracts:check` freshness-gates it exactly like the other five artifacts.

use std::collections::{HashMap, HashSet};

use mangostudio_runtime_contract::catalog::catalog;
use mangostudio_runtime_contract::schemas::{
    Violation, validate_event, validate_params, validate_result,
};
use serde::Deserialize;
use serde_json::Value;

const CORPUS_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../apps/shared/src/runtime-contract/generated/conformance-corpus.json"
));

#[derive(Debug, Deserialize)]
struct CorpusDocument {
    fixtures: Vec<Fixture>,
}

#[derive(Debug, Deserialize)]
struct Fixture {
    subject: Subject,
    mutation: String,
    value: Value,
    expect: Expect,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Subject {
    kind: SubjectKind,
    name: String,
    side: Option<Side>,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum SubjectKind {
    Method,
    Topic,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
enum Side {
    Params,
    Result,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Expect {
    Valid,
    Invalid,
}

fn corpus() -> CorpusDocument {
    serde_json::from_str(CORPUS_JSON).expect("conformance-corpus.json is well-formed JSON")
}

/// This crate's own verdict for one fixture, using the same `validate_*`
/// entry points a real dispatcher calls.
fn verdict_of(fixture: &Fixture) -> Result<(), Violation> {
    match (&fixture.subject.kind, &fixture.subject.side) {
        (SubjectKind::Method, Some(Side::Params)) => {
            validate_params(&fixture.subject.name, &fixture.value)
        }
        (SubjectKind::Method, Some(Side::Result)) => {
            validate_result(&fixture.subject.name, &fixture.value)
        }
        (SubjectKind::Topic, _) => validate_event(&fixture.subject.name, &fixture.value),
        (SubjectKind::Method, None) => {
            panic!("a method fixture must name a side: {:?}", fixture.subject)
        }
    }
}

#[test]
fn every_fixture_gets_the_verdict_typebox_recorded() {
    let document = corpus();
    assert!(
        !document.fixtures.is_empty(),
        "the corpus must not be empty"
    );

    let mut mismatches = Vec::new();
    for fixture in &document.fixtures {
        let outcome = verdict_of(fixture);
        let actual = if outcome.is_ok() {
            Expect::Valid
        } else {
            Expect::Invalid
        };
        if actual != fixture.expect {
            mismatches.push(format!(
                "{}:{}{} mutation={} expected={:?} actual={:?}{}",
                match fixture.subject.kind {
                    SubjectKind::Method => "method",
                    SubjectKind::Topic => "topic",
                },
                fixture.subject.name,
                fixture
                    .subject
                    .side
                    .as_ref()
                    .map(|side| format!(":{side:?}"))
                    .unwrap_or_default(),
                fixture.mutation,
                fixture.expect,
                actual,
                outcome
                    .err()
                    .map(|message| format!(" ({message})"))
                    .unwrap_or_default(),
            ));
        }
    }

    assert!(
        mismatches.is_empty(),
        "TypeBox and this crate's jsonschema validators disagree on {} fixture(s):\n{}",
        mismatches.len(),
        mismatches.join("\n")
    );
}

/// The mutation family a fixture's `mutation` field names — `drop:sessionId` and
/// `wrongType:cols` both collapse to `drop` and `wrongType`; `seed` and `extraProperty` carry
/// no suffix and pass through unchanged.
fn mutation_family(mutation: &str) -> &str {
    mutation.split(':').next().unwrap_or(mutation)
}

/// The JSON Schema keyword(s) a validator should report for an invalid fixture in
/// `mutation_family`, measured against the current corpus rather than guessed: every
/// `(family, keyword)` pair this crate's own validators actually produce across the corpus's
/// invalid fixtures, grouped by family. `anyOf` shows up alongside the "obvious" keyword for
/// every family here because a property that a mutation touches is often itself inside a
/// method's `anyOf`-shaped result — the validator reports the outer branch mismatch, not the
/// inner keyword, and both are the *right* reason to reject the fixture. `badPattern` is
/// included even though the current catalog's two top-level `pattern`-constrained properties
/// are both optional and neither is ever present in a generated seed (`Value.Create` only
/// populates required properties), so this family produces zero fixtures today — it stays
/// mapped for the day a required or defaulted property gains a `pattern`.
///
/// # Panics
/// Panics naming the unrecognised family when the corpus grows a mutation kind this mapping
/// does not cover — this must fail loudly rather than silently accept any keyword for an
/// unmapped family (which would defeat the point of this test).
fn expected_keywords_for(mutation_family: &str) -> &'static [&'static str] {
    match mutation_family {
        "drop" => &["required", "anyOf"],
        "wrongType" => &["type", "anyOf"],
        "extraProperty" => &["additionalProperties", "anyOf"],
        "outOfRange" => &["minimum", "maximum"],
        "wrongConst" => &["const", "anyOf", "type"],
        "tooShort" => &["minLength", "anyOf"],
        "tooLong" => &["maxLength", "anyOf"],
        "badPattern" => &["pattern", "anyOf"],
        "dupItems" => &["uniqueItems", "anyOf"],
        "tooManyItems" => &["maxItems", "anyOf"],
        "nullValue" => &["type", "anyOf"],
        other => panic!(
            "runtime-contract conformance: no expected-keyword mapping for mutation family {other:?}. Add one to expected_keywords_for() in tests/conformance.rs."
        ),
    }
}

/// A validator that rejects every invalid fixture for the *wrong* reason — a mis-resolved
/// `$ref` failing `required` regardless of what a fixture actually mutated, say — would still
/// pass [`every_fixture_gets_the_verdict_typebox_recorded`] at 100%, since that test only
/// checks valid-vs-invalid. This test additionally asserts the failing keyword this crate's
/// validators report is consistent with what the fixture's own `mutation` field says it
/// mutated, using the mapping in [`expected_keywords_for`].
#[test]
fn every_invalid_fixture_fails_for_the_keyword_its_mutation_predicts() {
    let document = corpus();
    let mut wrong_reason = Vec::new();

    for fixture in &document.fixtures {
        if fixture.expect != Expect::Invalid {
            continue;
        }
        let family = mutation_family(&fixture.mutation);
        let expected_keywords = expected_keywords_for(family);

        // A TypeBox/jsonschema valid-vs-invalid disagreement here is already reported by
        // `every_fixture_gets_the_verdict_typebox_recorded`; this test only has something to
        // say about *why* a validator rejected a value it was supposed to reject anyway.
        let Err(violation) = verdict_of(fixture) else {
            continue;
        };

        if !expected_keywords.contains(&violation.keyword.as_str()) {
            wrong_reason.push(format!(
                "{}:{}{} mutation={} keyword={} expected one of {expected_keywords:?}",
                match fixture.subject.kind {
                    SubjectKind::Method => "method",
                    SubjectKind::Topic => "topic",
                },
                fixture.subject.name,
                fixture
                    .subject
                    .side
                    .as_ref()
                    .map(|side| format!(":{side:?}"))
                    .unwrap_or_default(),
                fixture.mutation,
                violation.keyword,
            ));
        }
    }

    assert!(
        wrong_reason.is_empty(),
        "{} fixture(s) were rejected for a keyword their mutation does not predict — a \
         validator can reject a value for the wrong reason and still pass a bare pass/fail \
         check:\n{}",
        wrong_reason.len(),
        wrong_reason.join("\n")
    );
}

/// A subject with no valid seed would mean the corpus generator silently
/// skipped it — this test derives the full method/topic inventory from the
/// parsed catalog, not from a count typed here, so a method or topic added
/// to the contract is covered automatically.
#[test]
fn every_method_and_topic_in_the_catalog_has_at_least_one_valid_seed() {
    let document = corpus();
    let mut seeded_method_sides: HashSet<(String, Side)> = HashSet::new();
    let mut seeded_topics: HashSet<String> = HashSet::new();

    for fixture in &document.fixtures {
        if fixture.mutation != "seed" || fixture.expect != Expect::Valid {
            continue;
        }
        match (&fixture.subject.kind, fixture.subject.side) {
            (SubjectKind::Method, Some(side)) => {
                seeded_method_sides.insert((fixture.subject.name.clone(), side));
            }
            (SubjectKind::Topic, _) => {
                seeded_topics.insert(fixture.subject.name.clone());
            }
            (SubjectKind::Method, None) => {}
        }
    }

    let mut missing = Vec::new();
    for method in &catalog().methods {
        for side in [Side::Params, Side::Result] {
            if !seeded_method_sides.contains(&(method.name.clone(), side)) {
                missing.push(format!("method:{}:{:?}", method.name, side));
            }
        }
    }
    for event in &catalog().events {
        if !seeded_topics.contains(&event.topic) {
            missing.push(format!("topic:{}", event.topic));
        }
    }

    assert!(
        missing.is_empty(),
        "the corpus has no valid seed for: {}",
        missing.join(", ")
    );
}

/// Every subject the corpus carries names a real method or topic — a typo in
/// `scripts/runtime-contract/corpus.ts` would otherwise pass this test
/// silently by looking exactly like an "unknown subject" violation on both
/// sides.
#[test]
fn every_fixture_subject_names_a_method_or_topic_the_catalog_actually_has() {
    let method_names: HashMap<&str, ()> = catalog()
        .methods
        .iter()
        .map(|method| (method.name.as_str(), ()))
        .collect();
    let topic_names: HashMap<&str, ()> = catalog()
        .events
        .iter()
        .map(|event| (event.topic.as_str(), ()))
        .collect();

    for fixture in &corpus().fixtures {
        match fixture.subject.kind {
            SubjectKind::Method => assert!(
                method_names.contains_key(fixture.subject.name.as_str()),
                "corpus names an unknown method: {}",
                fixture.subject.name
            ),
            SubjectKind::Topic => assert!(
                topic_names.contains_key(fixture.subject.name.as_str()),
                "corpus names an unknown topic: {}",
                fixture.subject.name
            ),
        }
    }
}
