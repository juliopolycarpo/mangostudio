//! MCP client sessions owned by one runtime connection.
//!
//! `service` is the registry the `mcp.*` handlers share; `client` is the project-owned seam it
//! talks through; `sdk` is the one `rmcp`-backed implementation of that seam; `process` owns a
//! stdio server's process tree through the shared guardian/Job supervisor.

mod client;
mod consent;
#[cfg(test)]
mod fake_http;
mod http;
mod process;
mod sdk;
mod service;
mod sse;
mod stdio;
mod types;

pub(crate) use service::register;
