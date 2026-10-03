//! Model and user workspace operations share the same folder lock.
pub(crate) use workpilot_tools::mutation::{Lease, acquire};
