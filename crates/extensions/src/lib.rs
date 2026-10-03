//! Skills, immutable extension packages and bounded MCP connections.
mod manager;
pub mod mcp;
mod model;
mod oauth;
pub mod package;
#[cfg(test)]
mod tests;
pub use manager::Manager;
pub use manager::runtime_command;
pub type Result<T> = std::result::Result<T, String>;
pub fn digest(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}
