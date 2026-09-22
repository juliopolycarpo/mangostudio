//! Shell, Git, and GitHub CLI execution through the owned process supervisor.

pub mod environment;
pub mod gh_policy;
mod service;
pub mod toolchain;

pub(crate) use service::register;
