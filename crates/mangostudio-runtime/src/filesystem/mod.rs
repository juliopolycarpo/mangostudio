//! Filesystem operations and their byte-preserving helpers.

pub mod freshness;
mod io;
mod params;
mod patch;
mod patch_apply;
mod policy;
mod search;
mod service;
mod text;

pub(crate) use service::register;
