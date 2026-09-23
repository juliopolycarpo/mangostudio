//! MCP client sessions owned by one runtime connection.
//!
//! This first slice serves stdio `connect`, `list-tools`, and `disconnect`.
//! The manifest still withholds `mcp` until the whole catalog family works.

mod client;
mod consent;
mod process;
mod service;

pub(crate) use service::register;
