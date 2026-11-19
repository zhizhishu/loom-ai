//! Shared local IPC transport for Core and Node. No Core, database or runtime dependency.
//! Moved from rovai-core without weakening the native endpoint/DACL contract.
pub mod local_ipc;
pub use local_ipc::{
    LocalIpcAcceptError, LocalIpcClientStream, LocalIpcEndpoint, LocalIpcListener, LocalIpcStream,
};
