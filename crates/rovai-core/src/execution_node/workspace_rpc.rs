//! Private Hub journal adapter. No HTTP/Node payload can create a principal.
use super::NodeStore;
use crate::workspace_rpc::{
    CancelOutcome, RequestStatus, ResumeControl, TrustedPrincipal, WorkspaceRpcStore,
};
use crate::workspace_rpc_authority::revalidate_dispatch;
use loom_protocol::workspace_rpc::*;

impl NodeStore {
    pub fn rpc_prepare_dispatch(
        &self,
        dispatch: &WorkspaceDispatch,
        generation: u64,
        now: u64,
    ) -> Result<(), RpcErrorCode> {
        let mut conn = self.lock().map_err(|_| RpcErrorCode::StorageUnavailable)?;
        WorkspaceRpcStore::mark_dispatched_authorized(
            &mut conn,
            &dispatch.request.request_id,
            generation,
            now,
            |conn, stored| {
                if stored != dispatch {
                    return Err(RpcErrorCode::RequestConflict);
                }
                revalidate_dispatch(conn, stored)
            },
        )
    }
    pub fn rpc_resume_node(
        &self,
        node: &str,
        generation: u64,
        now: u64,
    ) -> Result<Vec<ResumeControl>, RpcErrorCode> {
        let mut conn = self.lock().map_err(|_| RpcErrorCode::StorageUnavailable)?;
        WorkspaceRpcStore::resume_node(&mut conn, node, generation, now)
    }
    pub fn rpc_disconnected(
        &self,
        node: &str,
        generation: u64,
        now: u64,
    ) -> Result<usize, RpcErrorCode> {
        let mut conn = self.lock().map_err(|_| RpcErrorCode::StorageUnavailable)?;
        WorkspaceRpcStore::mark_disconnected(&mut conn, node, generation, now)
    }
    pub fn rpc_append_event(
        &self,
        node: &str,
        generation: u64,
        event: &WorkspaceEvent,
        now: u64,
    ) -> Result<(), RpcErrorCode> {
        let mut conn = self.lock().map_err(|_| RpcErrorCode::StorageUnavailable)?;
        WorkspaceRpcStore::append_event(&mut conn, node, generation, event, now).map(|_| ())
    }
    pub fn rpc_rejected(
        &self,
        node: &str,
        generation: u64,
        rejection: &WorkspaceRejection,
        now: u64,
    ) -> Result<(), RpcErrorCode> {
        let mut conn = self.lock().map_err(|_| RpcErrorCode::StorageUnavailable)?;
        let stored = WorkspaceRpcStore::trusted_status(&conn, &rejection.request_id)?;
        rejection.validate_for(&stored.dispatch)?;
        WorkspaceRpcStore::mark_delivery_unknown(
            &mut conn,
            node,
            generation,
            &rejection.request_id,
            rejection.code,
            now,
        )
    }
    pub fn rpc_delivery_unknown(
        &self,
        node: &str,
        generation: u64,
        id: &str,
        now: u64,
    ) -> Result<(), RpcErrorCode> {
        let mut conn = self.lock().map_err(|_| RpcErrorCode::StorageUnavailable)?;
        WorkspaceRpcStore::mark_delivery_unknown(
            &mut conn,
            node,
            generation,
            id,
            RpcErrorCode::UnknownOutcome,
            now,
        )
    }
    pub fn rpc_validate_replay(
        &self,
        node: &str,
        generation: u64,
        replay: &WorkspaceReplay,
    ) -> Result<(), RpcErrorCode> {
        let conn = self.lock().map_err(|_| RpcErrorCode::StorageUnavailable)?;
        let stored = WorkspaceRpcStore::trusted_status(&conn, &replay.request_id)?;
        replay.validate_for(&stored.dispatch)?;
        if stored.dispatch.owner_node_id != node {
            return Err(RpcErrorCode::WrongNode);
        }
        let recorded: i64 = conn
            .query_row(
                "SELECT online_generation FROM workspace_rpc_requests WHERE request_id=?1",
                [&replay.request_id],
                |row| row.get(0),
            )
            .map_err(|_| RpcErrorCode::StorageUnavailable)?;
        if u64::try_from(recorded).ok() != Some(generation) {
            return Err(RpcErrorCode::WrongNode);
        }
        if matches!(stored.state, crate::workspace_rpc::RequestState::Queued) {
            return Err(RpcErrorCode::RequestConflict);
        }
        Ok(())
    }
    pub fn rpc_validate_cancel(
        &self,
        node: &str,
        generation: u64,
        cancel: &WorkspaceCancel,
    ) -> Result<(), RpcErrorCode> {
        let replay = WorkspaceReplay {
            version: cancel.version,
            request_id: cancel.request_id.clone(),
            run_id: cancel.run_id.clone(),
            attempt: cancel.attempt,
            request_digest: cancel.request_digest.clone(),
            after_seq: 0,
        };
        self.rpc_validate_replay(node, generation, &replay)
    }
    pub fn rpc_pending(&self, node: &str) -> Result<Vec<RequestStatus>, RpcErrorCode> {
        let conn = self.lock().map_err(|_| RpcErrorCode::StorageUnavailable)?;
        WorkspaceRpcStore::pending_for_node(&conn, node)
    }
    pub fn rpc_cancel_stale(
        &self,
        node: &str,
        now: u64,
    ) -> Result<Vec<WorkspaceCancel>, RpcErrorCode> {
        let mut conn = self.lock().map_err(|_| RpcErrorCode::StorageUnavailable)?;
        let pending = WorkspaceRpcStore::pending_for_node(&conn, node)?;
        let mut output = Vec::new();
        for status in pending {
            let cause = if now >= status.dispatch.deadline_unix_ms {
                Some(CancelCause::Deadline)
            } else {
                match revalidate_dispatch(&conn, &status.dispatch) {
                    Ok(()) => None,
                    Err(
                        RpcErrorCode::Unauthorized
                        | RpcErrorCode::PolicyMismatch
                        | RpcErrorCode::ToolDenied,
                    ) => Some(CancelCause::User),
                    Err(error) => return Err(error),
                }
            };
            if let Some(cause) = cause {
                if let CancelOutcome::Forward(cancel) = WorkspaceRpcStore::cancel(
                    &mut conn,
                    &TrustedPrincipal::AgentRun(status.dispatch.scope),
                    &status.request_id,
                    cause,
                    now,
                )? {
                    output.push(cancel);
                }
            }
        }
        Ok(output)
    }
    pub fn rpc_recover(&self, now: u64) -> Result<usize, RpcErrorCode> {
        let mut conn = self.lock().map_err(|_| RpcErrorCode::StorageUnavailable)?;
        WorkspaceRpcStore::recover_inflight(&mut conn, now)
    }
}
