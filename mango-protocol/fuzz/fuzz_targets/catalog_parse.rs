//! `Catalog` parsing from arbitrary JSON bytes: must never panic, whether the
//! bytes parse as a catalog, as some other JSON shape, or not at all.
#![no_main]

use libfuzzer_sys::fuzz_target;
use mango_protocol::Catalog;

fuzz_target!(|data: &[u8]| {
    if let Ok(catalog) = serde_json::from_slice::<Catalog>(data) {
        let _ = catalog.validate();
    }
});
