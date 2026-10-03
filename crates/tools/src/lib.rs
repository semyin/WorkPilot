//! File capabilities and explicit process boundaries, independent of the UI.
pub mod binary;
pub mod files;
pub mod mutation;
pub mod registry;
pub use registry::*;
pub mod worker;
