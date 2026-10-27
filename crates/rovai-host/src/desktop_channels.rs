//! Parent-pipe adapter. Dispatch is acknowledged immediately; the Core queue
//! must remain free while Desktop's existing service calls Core and persists
//! publication progress. Losing an HTTP waiter never cancels Desktop work.
use rovai_core::application::{CoreService, HostControlError};
use rovai_web::{ChannelFuture, ChannelHost, ChannelRequest};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Semaphore, oneshot};

struct Pending {
    request: Value,
    dispatched: bool,
    reply: oneshot::Sender<Value>,
}

pub struct DesktopChannels {
    core: CoreService,
    sequence: AtomicU64,
    pending: Mutex<HashMap<String, Pending>>,
    capacity: Semaphore,
}

impl DesktopChannels {
    pub fn new(core: CoreService) -> Self {
        Self {
            core,
            sequence: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            capacity: Semaphore::new(16),
        }
    }

    pub fn dispatch(&self, params: Value) -> Result<Value, HostControlError> {
        let id = params["requestId"].as_str().ok_or_else(invalid)?;
        let mut pending = self.pending.lock().map_err(|_| invalid())?;
        let request = pending.get_mut(id).ok_or_else(invalid)?;
        if request.dispatched {
            return Err(invalid());
        }
        request.dispatched = true;
        Ok(json!({"requestId":id,"request":request.request}))
    }

    pub fn reply(&self, params: Value) -> Result<Value, HostControlError> {
        let id = params["requestId"].as_str().ok_or_else(invalid)?;
        let pending = self.pending.lock().map_err(|_| invalid())?.remove(id);
        if let Some(pending) = pending {
            if !pending.dispatched {
                return Err(invalid());
            }
            let reply = &params["reply"];
            if serde_json::to_vec(reply).map_err(|_| invalid())?.len() > 1024 * 1024 {
                return Err(invalid());
            }
            let _ = pending.reply.send(reply.clone());
        }
        // A late result after a disconnected browser is normal. Desktop work
        // already persisted its original identity and remains independently owned.
        Ok(json!({"accepted":true}))
    }
}

fn invalid() -> HostControlError {
    HostControlError {
        code: "HOST_CHANNEL_REQUEST_INVALID",
        message: "Invalid Desktop channel exchange".into(),
    }
}

struct Waiter<'a> {
    bridge: &'a DesktopChannels,
    id: String,
}
impl Drop for Waiter<'_> {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.bridge.pending.lock() {
            pending.remove(&self.id);
        }
    }
}

impl ChannelHost for DesktopChannels {
    fn call(&self, request: ChannelRequest) -> ChannelFuture<'_> {
        Box::pin(async move {
            let _permit = self
                .capacity
                .try_acquire()
                .map_err(|_| "channel_capacity")?;
            let id = self.sequence.fetch_add(1, Ordering::Relaxed).to_string();
            let (reply, received) = oneshot::channel();
            self.pending
                .lock()
                .map_err(|_| "channel_unavailable")?
                .insert(
                    id.clone(),
                    Pending {
                        request: serde_json::to_value(request)
                            .map_err(|_| "operation_not_admitted")?,
                        dispatched: false,
                        reply,
                    },
                );
            let waiter = Waiter { bridge: self, id };
            let exchange = async {
                let dispatch = self
                    .core
                    .request("host.channels.dispatch", json!({"requestId":waiter.id}))
                    .await
                    .map_err(|_| "channel_result_unavailable")?;
                if dispatch.error.is_some() {
                    return Err("channel_unavailable");
                }
                let response = received.await.map_err(|_| "channel_result_unavailable")?;
                // The parent returns only a projected public DTO or a closed
                // failure. Never relay a raw exception or arbitrary error text.
                if let Some(code) = response["error"].as_str() {
                    return Err(match code {
                        "channel_session_expired" => "channel_session_expired",
                        "channel_native_interaction" => "channel_native_interaction",
                        "channel_operation_failed" => "channel_operation_failed",
                        _ => "channel_result_unavailable",
                    });
                }
                let snapshot = &response["result"];
                if snapshot["schemaVersion"] != 4
                    || !snapshot["channels"].is_array()
                    || !snapshot["activeQrAttempt"].is_null()
                {
                    return Err("channel_unavailable");
                }
                Ok(snapshot.clone())
            };
            tokio::time::timeout(Duration::from_secs(60), exchange)
                .await
                .map_err(|_| "channel_result_unavailable")?
        })
    }
}
