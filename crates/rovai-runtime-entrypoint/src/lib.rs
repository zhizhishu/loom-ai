//! Shared native Windows runtime entrypoint resolution.
//! Extracted without changing the existing Core discovery semantics or owner tests.
#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::*;
