//! Computer transport over the authenticated node WebSocket.
//!
//! This is routing only: it never captures, never injects and never decides
//! consent. Every request is fenced to the connection generation its caller
//! authenticated against — checked in the same critical section that registers
//! the waiter, and the same generation is sent under — and every reply is
//! fenced to the generation of the socket it arrived on. A frame produced by a
//! replaced socket can never be handed to a caller that asked the new one, and a
//! request admitted for a replaced socket is refused instead of being delivered
//! to its replacement. There is no second scheduler: the work happens on the
//! node, and this module only correlates bounded request/response pairs.
use super::{Hub, Inner};
use loom_protocol::ServerMessage;
use loom_protocol::computer::{
    COMPUTER_VERSION, ComputerCodeV1, ComputerFrameChunkV1, ComputerFrameHeaderV1, ComputerReplyV1,
    ComputerRequestV1, MAX_FRAME_BYTES,
};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::oneshot;

/// Pending computer requests allowed per node at once.
pub(crate) const MAX_COMPUTER_WAITS: usize = 4;
/// One operation, including a capture, measured from dispatch.
pub(crate) const COMPUTER_DEADLINE: Duration = Duration::from_secs(14);

/// A completed operation. `png` is present only for a capture that delivered
/// every chunk it announced.
pub(crate) struct ComputerOutcome {
    pub(crate) reply: ComputerReplyV1,
    pub(crate) png: Option<Vec<u8>>,
}

pub(super) struct ComputerWait {
    pub(super) node_id: String,
    pub(super) generation: u64,
    pub(super) deadline: Instant,
    pub(super) request: ComputerRequestV1,
    pub(super) header: Option<ComputerFrameHeaderV1>,
    pub(super) next_seq: u32,
    pub(super) png: Vec<u8>,
    pub(super) done: Option<oneshot::Sender<ComputerOutcome>>,
}

impl ComputerWait {
    fn matches(&self, node_id: &str, generation: u64) -> bool {
        self.node_id == node_id && self.generation == generation
    }
}

/// Blocking entry point used by the provider, which already runs inside a
/// `spawn_blocking` section. The async body owns every Tokio mutex for exactly
/// one critical section, so no guard is ever held across an await.
pub(crate) fn request_blocking(
    hub: &Arc<Hub>,
    node_id: &str,
    expected_generation: u64,
    request: ComputerRequestV1,
    budget: Duration,
) -> Result<ComputerOutcome, &'static str> {
    let handle = tokio::runtime::Handle::try_current().map_err(|_| "computer_busy")?;
    handle.block_on(hub.computer_request(node_id, expected_generation, request, budget))
}

impl Hub {
    /// Send one closed operation to a node and wait for its bounded reply.
    ///
    /// `expected_generation` is the connection the caller authenticated against,
    /// not merely the connection that happens to be current now. It is checked
    /// in the same critical section that reads the node and registers the waiter,
    /// and that same generation is the one the frame is sent under, so a request
    /// built for a socket that has since been replaced can never be registered
    /// and sent on its replacement — not even when the reconnect lands between a
    /// caller's own pre-check and this call.
    pub(crate) async fn computer_request(
        &self,
        node_id: &str,
        expected_generation: u64,
        request: ComputerRequestV1,
        budget: Duration,
    ) -> Result<ComputerOutcome, &'static str> {
        request.validate().map_err(code_text)?;
        let request_id = request.request_id.clone();
        let (generation, rx) = {
            let mut inner = self.inner.lock().await;
            if inner.revoked.contains(node_id) {
                return Err("token_revoked");
            }
            let now = Instant::now();
            // A caller that vanished without a reply leaves only an expired
            // entry behind; nothing is inferred from it.
            inner.computer_waits.retain(|_, wait| wait.deadline > now);
            if inner.computer_waits.contains_key(&request_id) {
                return Err("computer_request_conflict");
            }
            if inner
                .computer_waits
                .values()
                .filter(|wait| wait.node_id == node_id)
                .count()
                >= MAX_COMPUTER_WAITS
            {
                return Err("computer_busy");
            }
            let node = inner.nodes.get(node_id).ok_or("node_offline")?;
            if node.outbound.is_none() {
                return Err("node_offline");
            }
            // The fence: this node is live, but it is not the connection this
            // request was built for. A replaced socket must refuse rather than
            // be handed the operation, and the check has to happen here — under
            // the same lock that registers the waiter — because a caller's own
            // pre-check cannot be atomic with this registration.
            if node.generation != expected_generation {
                return Err("node_connection_changed");
            }
            if !node.computer_versions.contains(&COMPUTER_VERSION) {
                return Err("computer_version_unsupported");
            }
            // The registered and sent generation is the caller's, never a value
            // re-read here: both are the same connection by the check above.
            let generation = expected_generation;
            let (tx, rx) = oneshot::channel();
            inner.computer_waits.insert(
                request_id.clone(),
                ComputerWait {
                    node_id: node_id.to_owned(),
                    generation,
                    deadline: now + budget,
                    request: request.clone(),
                    header: None,
                    next_seq: 1,
                    png: Vec::new(),
                    done: Some(tx),
                },
            );
            (generation, rx)
        };
        // The send is fenced again inside `send_node_message_generation`, which
        // re-checks the connection generation and the advertised capability. It
        // is handed the generation the fence above accepted, so a reconnect that
        // lands between registration and delivery is refused there as well.
        if let Err(code) = self
            .send_node_message_generation(
                node_id,
                generation,
                ServerMessage::Computer { request },
                false,
            )
            .await
        {
            self.abandon_computer_wait(node_id, &request_id);
            return Err(code);
        }
        match tokio::time::timeout(budget, rx).await {
            Ok(Ok(outcome)) => Ok(outcome),
            // A dropped sender means the waiter was retired by a disconnect or a
            // revocation. The caller must treat that as unknown, never success.
            Ok(Err(_)) => Err("node_offline"),
            Err(_) => {
                self.abandon_computer_wait(node_id, &request_id);
                Err("computer_timeout")
            }
        }
    }

    /// Current connection generation for a node that advertises computer.
    pub(crate) async fn computer_generation(&self, node_id: &str) -> Option<u64> {
        let inner = self.inner.lock().await;
        inner
            .nodes
            .get(node_id)
            .filter(|node| {
                node.outbound.is_some() && node.computer_versions.contains(&COMPUTER_VERSION)
            })
            .map(|node| node.generation)
    }

    fn abandon_computer_wait(&self, node_id: &str, request_id: &str) {
        // A waiter that cannot be retired here is retired by the deadline prune.
        if let Ok(mut inner) = self.inner.try_lock()
            && inner
                .computer_waits
                .get(request_id)
                .is_some_and(|wait| wait.node_id == node_id)
        {
            inner.computer_waits.remove(request_id);
        }
    }

    /// Accept a reply frame from the node that owns the waiter. A capture reply
    /// only installs a header; its pixels arrive as separately fenced chunks.
    pub(super) async fn handle_computer_reply(
        &self,
        node_id: &str,
        generation: u64,
        reply: ComputerReplyV1,
    ) {
        let mut inner = self.inner.lock().await;
        let request_id = reply.request_id.clone();
        let Some((matches, valid)) = inner
            .computer_waits
            .get(&request_id)
            .map(|wait| (wait.matches(node_id, generation), reply.validate_for(&wait.request).is_ok()))
        else {
            return;
        };
        if !matches {
            return;
        }
        if !valid {
            inner.computer_waits.remove(&request_id);
            return;
        }
        match reply.frame {
            Some(header) => {
                if header.validate().is_err() {
                    inner.computer_waits.remove(&request_id);
                    return;
                }
                if let Some(wait) = inner.computer_waits.get_mut(&request_id) {
                    wait.header = Some(header);
                    wait.next_seq = 1;
                    wait.png.clear();
                }
            }
            None => {
                if let Some(wait) = inner.computer_waits.remove(&request_id)
                    && let Some(done) = wait.done
                {
                    let _ = done.send(ComputerOutcome { reply, png: None });
                }
            }
        }
    }

    /// Accept one chunk. Strictly ordered, bounded, and discarded when the
    /// connection generation no longer matches.
    pub(super) async fn handle_computer_chunk(
        &self,
        node_id: &str,
        generation: u64,
        chunk: ComputerFrameChunkV1,
    ) {
        let mut inner = self.inner.lock().await;
        let request_id = chunk.request_id.clone();
        let Some((matches, header, expected_seq)) = inner.computer_waits.get(&request_id).map(|wait| {
            (
                wait.matches(node_id, generation),
                wait.header,
                wait.next_seq,
            )
        }) else {
            return;
        };
        if !matches {
            return;
        }
        let Some(header) = header else {
            // A chunk before any header cannot belong to a capture we asked for.
            inner.computer_waits.remove(&request_id);
            return;
        };
        if chunk.validate_for(&header).is_err() || chunk.seq != expected_seq {
            inner.computer_waits.remove(&request_id);
            return;
        }
        let Ok(decoded) = decode_chunk(&chunk, &header) else {
            inner.computer_waits.remove(&request_id);
            return;
        };
        let Some(mut wait) = inner.computer_waits.remove(&request_id) else {
            return;
        };
        // Over the declared bound: drop the waiter so the caller sees an unknown
        // outcome instead of a truncated image presented as a real screen.
        if wait.png.len() + decoded.len() > MAX_FRAME_BYTES as usize {
            return;
        }
        wait.png.extend_from_slice(&decoded);
        wait.next_seq = expected_seq.saturating_add(1);
        if chunk.seq != header.chunk_count {
            inner.computer_waits.insert(request_id, wait);
            return;
        }
        if wait.png.len() != header.total_bytes as usize {
            return;
        }
        if let Some(done) = wait.done {
            let reply = ComputerReplyV1 {
                version: COMPUTER_VERSION,
                request_id: wait.request.request_id.clone(),
                code: ComputerCodeV1::Ok,
                device: None,
                frame: Some(header),
            };
            let _ = done.send(ComputerOutcome {
                reply,
                png: Some(wait.png),
            });
        }
    }
}

fn decode_chunk(
    chunk: &ComputerFrameChunkV1,
    header: &ComputerFrameHeaderV1,
) -> Result<Vec<u8>, ComputerCodeV1> {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    let decoded = STANDARD
        .decode(chunk.data.as_bytes())
        .map_err(|_| ComputerCodeV1::InvalidRequest)?;
    if decoded.len() > header.chunk_bytes as usize {
        return Err(ComputerCodeV1::InvalidRequest);
    }
    Ok(decoded)
}

fn code_text(code: ComputerCodeV1) -> &'static str {
    code.code()
}

/// Retire every pending computer request owned by a node. Called on detach and
/// on revoke, so a caller never waits out a full deadline for a socket that is
/// already gone.
pub(super) fn fail_computer_waiters(inner: &mut Inner, node_id: &str) {
    let ids: Vec<String> = inner
        .computer_waits
        .iter()
        .filter(|(_, wait)| wait.node_id == node_id)
        .map(|(id, _)| id.clone())
        .collect();
    for id in ids {
        // Dropping the sender fails the waiting caller; no outcome is invented.
        inner.computer_waits.remove(&id);
    }
}
