//! Derive the embedded catalog without changing the readable canonical artifact.

#[path = "build_support/compact_json.rs"]
mod compact_json;

fn main() {
    use std::{env, fs, path::PathBuf};

    let manifest =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("Cargo manifest directory"));
    let source = manifest.join("../../apps/shared/src/runtime-contract/generated/catalog.json");
    println!("cargo:rerun-if-changed={}", source.display());
    println!("cargo:rerun-if-changed=build_support/compact_json.rs");
    let source = fs::read_to_string(source).expect("read canonical runtime catalog");
    let destination = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo build output directory"))
        .join("catalog.compact.json");
    compact_json::write_compact_catalog(&destination, &source)
        .expect("write compact runtime catalog");
}
