//! The shared product descriptor, never parsed from a vendor-provided command string.
use serde::Deserialize;
use std::collections::BTreeMap;
use std::sync::OnceLock;

#[derive(Deserialize)]
pub(crate) struct LoginDescriptor {
    pub(crate) program: String,
    pub(crate) args: Vec<String>,
}

pub(crate) fn descriptors() -> &'static BTreeMap<String, LoginDescriptor> {
    static DESCRIPTORS: OnceLock<BTreeMap<String, LoginDescriptor>> = OnceLock::new();
    DESCRIPTORS.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../../apps/shared/src/external-agents/login.json"
        ))
        .expect("checked login descriptors")
    })
}

pub(crate) fn command(target: &str) -> &'static str {
    static COMMANDS: OnceLock<BTreeMap<String, String>> = OnceLock::new();
    COMMANDS.get_or_init(|| {
        descriptors()
            .iter()
            .map(|(target, descriptor)| {
                let mut argv = vec![descriptor.program.clone()];
                argv.extend(descriptor.args.clone());
                (target.clone(), argv.join(" "))
            })
            .collect()
    })[target]
        .as_str()
}
