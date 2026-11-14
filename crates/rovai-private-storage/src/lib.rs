//! Shared private filesystem primitives. No Core, database or runtime dependency.
//! Moved from rovai-core without weakening the native permission contract.
pub mod private_storage;
#[cfg(windows)]
mod windows_path;
#[cfg(windows)]
pub mod windows_security;
pub use private_storage::*;
