//! Trusted database authority for workspace RPC. Caller identity is supplied
//! by the already authenticated Core Built-in Tool lease, never JSON input.
use crate::{
    team_tool::AuthenticatedTeamToolRun,
    workspace_rpc::{TrustedPrincipal, WorkspaceGrant},
};
use loom_protocol::workspace_rpc::*;
use rusqlite::{Connection, OptionalExtension, params};
use std::collections::BTreeSet;

pub fn resolve_workspace_authority(
    conn: &Connection,
    authenticated: &AuthenticatedTeamToolRun,
    workspace_id: &str,
    online_generation: Option<u64>,
) -> Result<(TrustedPrincipal, WorkspaceGrant), RpcErrorCode> {
    let attempt =
        u32::try_from(authenticated.execution_epoch).map_err(|_| RpcErrorCode::Unauthorized)?;
    if attempt == 0 {
        return Err(RpcErrorCode::Unauthorized);
    }
    // Membership comes from conversation.agent_id/camp_id. agent_run has no
    // caller-supplied member field; workspace ownership comes from its Mission.
    let row: Option<(String, String, String, i64)> = conn
        .query_row(
            "SELECT r.conversation_id,m.id,w.execution_host_id,w.generation
         FROM agent_run r
         JOIN conversation c ON c.id=r.conversation_id
         JOIN camp_member cm ON cm.camp_id=c.camp_id AND cm.agent_id=c.agent_id
         JOIN mission m ON m.camp_id=c.camp_id
         JOIN mission_workspace w ON w.mission_id=m.id AND w.camp_id=c.camp_id
         JOIN execution_node n ON n.node_id=w.execution_host_id
         WHERE r.id=?1 AND r.execution_epoch=?2
         AND r.status IN ('running','waiting') AND r.cancel_requested_at IS NULL
         AND c.agent_id=?3 AND c.camp_id=?4
         AND cm.status='active' AND cm.leave_requested_at IS NULL
         AND w.id=?5 AND w.state='ready' AND length(w.preparation_token)>0
         AND n.revoked_at IS NULL",
            params![
                authenticated.agent_run_id,
                authenticated.execution_epoch,
                authenticated.agent_id,
                authenticated.camp_id,
                workspace_id
            ],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|_| RpcErrorCode::StorageUnavailable)?;
    let (session_id, mission_id, owner_node_id, revision) =
        row.ok_or(RpcErrorCode::Unauthorized)?;
    let policy_revision = u64::try_from(revision)
        .ok()
        .filter(|r| *r > 0)
        .ok_or(RpcErrorCode::PolicyMismatch)?;
    let scope = CallerScope {
        run_id: authenticated.agent_run_id.clone(),
        attempt,
        session_id,
        member_id: authenticated.agent_id.clone(),
        mission_id: mission_id.clone(),
    };
    scope.validate().map_err(|_| RpcErrorCode::Unauthorized)?;
    let grant = WorkspaceGrant {
        workspace_id: workspace_id.to_owned(),
        mission_id,
        owner_node_id,
        policy_revision,
        allow_list: true,
        allow_read: true,
        // The same mission-workspace authorization that admits a read admits a
        // write; the node still bounds the target to the prepared worktree.
        allow_write: true,
        allowed_tools: BTreeSet::from(["git.status".to_owned()]),
        online_generation,
    };
    Ok((TrustedPrincipal::AgentRun(scope), grant))
}

/// The one ready remote workspace this Run's Mission owns, for a tool call that
/// omitted `workspaceId`. The Run, its Member and its camp all come from the
/// already authenticated lease; the model names none of them.
///
/// The candidate set is the same mission-workspace authorization that admits the
/// request, narrowed to `n.role='remote'`: a local execution row is this Host's
/// own directory and is never offered as a remote target. Zero candidates are
/// `NotFound` and more than one is `InvalidRequest` — both existing variants, so
/// no new wire error appears. An ineligible Run reads the same `NotFound` as a
/// Mission without a prepared remote workspace and learns nothing extra; the
/// resolved id is still authorized against the Run afterwards.
pub fn resolve_mission_remote_workspace(
    conn: &Connection,
    authenticated: &AuthenticatedTeamToolRun,
) -> Result<String, RpcErrorCode> {
    let mut statement = conn
        .prepare(
            "SELECT w.id
               FROM agent_run r
               JOIN conversation c ON c.id=r.conversation_id
               JOIN camp_member cm ON cm.camp_id=c.camp_id AND cm.agent_id=c.agent_id
               JOIN mission m ON m.camp_id=c.camp_id
               JOIN mission_workspace w ON w.mission_id=m.id AND w.camp_id=c.camp_id
               JOIN execution_node n ON n.node_id=w.execution_host_id
              WHERE r.id=?1 AND r.execution_epoch=?2
                AND r.status IN ('running','waiting') AND r.cancel_requested_at IS NULL
                AND c.agent_id=?3 AND c.camp_id=?4
                AND cm.status='active' AND cm.leave_requested_at IS NULL
                AND w.state='ready' AND length(w.preparation_token)>0
                AND n.revoked_at IS NULL AND n.role='remote'
              ORDER BY w.created_at, w.id
              LIMIT 2",
        )
        .map_err(|_| RpcErrorCode::StorageUnavailable)?;
    let candidates = statement
        .query_map(
            params![
                authenticated.agent_run_id,
                authenticated.execution_epoch,
                authenticated.agent_id,
                authenticated.camp_id
            ],
            |row| row.get::<_, String>(0),
        )
        .map_err(|_| RpcErrorCode::StorageUnavailable)?
        .collect::<rusqlite::Result<Vec<String>>>()
        .map_err(|_| RpcErrorCode::StorageUnavailable)?;
    match candidates.len() {
        0 => Err(RpcErrorCode::NotFound),
        1 => candidates
            .into_iter()
            .next()
            .ok_or(RpcErrorCode::NotFound),
        // Two ready remote workspaces are a real choice, and only the caller can
        // make it; guessing would silently write into the wrong machine.
        _ => Err(RpcErrorCode::InvalidRequest),
    }
}

/// The Hub invokes this on the exact journaled dispatch immediately before
/// queueing it. A slow prepare cannot authorize a Run that ended meanwhile.
pub fn revalidate_dispatch(
    conn: &Connection,
    dispatch: &WorkspaceDispatch,
) -> Result<(), RpcErrorCode> {
    dispatch.validate()?;
    let camp: Option<String> = conn
        .query_row(
            "SELECT c.camp_id FROM agent_run r JOIN conversation c ON c.id=r.conversation_id
         WHERE r.id=?1 AND c.id=?2 AND c.agent_id=?3",
            params![
                dispatch.scope.run_id,
                dispatch.scope.session_id,
                dispatch.scope.member_id
            ],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| RpcErrorCode::StorageUnavailable)?;
    let authenticated = AuthenticatedTeamToolRun {
        camp_id: camp.ok_or(RpcErrorCode::Unauthorized)?,
        agent_id: dispatch.scope.member_id.clone(),
        agent_run_id: dispatch.scope.run_id.clone(),
        execution_epoch: i64::from(dispatch.scope.attempt),
    };
    let (principal, grant) =
        resolve_workspace_authority(conn, &authenticated, &dispatch.request.workspace_id, None)?;
    let TrustedPrincipal::AgentRun(scope) = principal else {
        return Err(RpcErrorCode::Unauthorized);
    };
    if scope != dispatch.scope {
        return Err(RpcErrorCode::Unauthorized);
    }
    if grant.owner_node_id != dispatch.owner_node_id
        || grant.policy_revision != dispatch.policy_revision
    {
        return Err(RpcErrorCode::PolicyMismatch);
    }
    let allowed = match &dispatch.request.operation {
        WorkspaceOperation::List { .. } => grant.allow_list,
        WorkspaceOperation::Read { .. } => grant.allow_read,
        WorkspaceOperation::Write { .. } => grant.allow_write,
        WorkspaceOperation::Run { tool_id, .. } => grant.allowed_tools.contains(tool_id),
    };
    if !allowed {
        return Err(RpcErrorCode::ToolDenied);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Connection, AuthenticatedTeamToolRun) {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("
            CREATE TABLE agent_run(id TEXT,conversation_id TEXT,execution_epoch INTEGER,status TEXT,cancel_requested_at TEXT);
            CREATE TABLE conversation(id TEXT,agent_id TEXT,camp_id TEXT);
            CREATE TABLE camp_member(camp_id TEXT,agent_id TEXT,status TEXT,leave_requested_at TEXT);
            CREATE TABLE mission(id TEXT,camp_id TEXT);
            CREATE TABLE mission_workspace(id TEXT,mission_id TEXT,camp_id TEXT,execution_host_id TEXT,generation INTEGER,state TEXT,preparation_token TEXT);
            CREATE TABLE execution_node(node_id TEXT,revoked_at TEXT);
            INSERT INTO agent_run VALUES('run','session',7,'running',NULL);
            INSERT INTO conversation VALUES('session','member','camp');
            INSERT INTO camp_member VALUES('camp','member','active',NULL);
            INSERT INTO mission VALUES('mission','camp');
            INSERT INTO mission_workspace VALUES('workspace','mission','camp','node-b',3,'ready','fixture-preparation');
            INSERT INTO execution_node VALUES('node-b',NULL);
        ").unwrap();
        (
            db,
            AuthenticatedTeamToolRun {
                camp_id: "camp".into(),
                agent_id: "member".into(),
                agent_run_id: "run".into(),
                execution_epoch: 7,
            },
        )
    }
    /// The same shape as `fixture`, with the two columns the remote resolver reads:
    /// the row's creation order and the owner node's role.
    fn remote_workspace_fixture() -> (Connection, AuthenticatedTeamToolRun) {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "
            CREATE TABLE agent_run(id TEXT,conversation_id TEXT,execution_epoch INTEGER,status TEXT,cancel_requested_at TEXT);
            CREATE TABLE conversation(id TEXT,agent_id TEXT,camp_id TEXT);
            CREATE TABLE camp_member(camp_id TEXT,agent_id TEXT,status TEXT,leave_requested_at TEXT);
            CREATE TABLE mission(id TEXT,camp_id TEXT);
            CREATE TABLE mission_workspace(id TEXT,mission_id TEXT,camp_id TEXT,execution_host_id TEXT,created_at TEXT,state TEXT,preparation_token TEXT);
            CREATE TABLE execution_node(node_id TEXT,role TEXT,revoked_at TEXT);
            INSERT INTO agent_run VALUES('run','session',7,'running',NULL);
            INSERT INTO conversation VALUES('session','member','camp');
            INSERT INTO camp_member VALUES('camp','member','active',NULL);
            INSERT INTO mission VALUES('mission','camp');
            INSERT INTO execution_node VALUES('node-b','remote',NULL);
            INSERT INTO execution_node VALUES('node-c','remote',NULL);
            INSERT INTO execution_node VALUES('host','local',NULL);
        ",
        )
        .unwrap();
        (
            db,
            AuthenticatedTeamToolRun {
                camp_id: "camp".into(),
                agent_id: "member".into(),
                agent_run_id: "run".into(),
                execution_epoch: 7,
            },
        )
    }
    fn ready_workspace(db: &Connection, id: &str, host: &str, created_at: &str) {
        db.execute(
            "INSERT INTO mission_workspace(id,mission_id,camp_id,execution_host_id,created_at,state,preparation_token)
             VALUES(?1,'mission','camp',?2,?3,'ready','fixture-preparation')",
            params![id, host, created_at],
        )
        .unwrap();
    }
    /// An omitted workspaceId resolves only from the authenticated Run's own Mission,
    /// only on a remote node, and only when exactly one candidate exists.
    #[test]
    fn an_omitted_workspace_id_resolves_only_one_ready_remote_workspace() {
        let (db, auth) = remote_workspace_fixture();
        // Zero candidates: this Mission has nothing prepared.
        assert_eq!(
            resolve_mission_remote_workspace(&db, &auth),
            Err(RpcErrorCode::NotFound)
        );
        // This Host's own execution row is not a remote target, so it is not a candidate.
        ready_workspace(&db, "workspace-local", "host", "2026-01-01T00:00:01Z");
        assert_eq!(
            resolve_mission_remote_workspace(&db, &auth),
            Err(RpcErrorCode::NotFound)
        );
        // Exactly one remote candidate is used without asking.
        ready_workspace(&db, "workspace-b", "node-b", "2026-01-01T00:00:02Z");
        assert_eq!(
            resolve_mission_remote_workspace(&db, &auth).unwrap(),
            "workspace-b"
        );
        // Two remote candidates are a real choice: the caller must name one.
        ready_workspace(&db, "workspace-c", "node-c", "2026-01-01T00:00:03Z");
        assert_eq!(
            resolve_mission_remote_workspace(&db, &auth),
            Err(RpcErrorCode::InvalidRequest)
        );
        db.execute("DELETE FROM mission_workspace WHERE id='workspace-c'", [])
            .unwrap();
        assert_eq!(
            resolve_mission_remote_workspace(&db, &auth).unwrap(),
            "workspace-b"
        );
        // A row that is no longer ready, or whose node was revoked, is not prepared.
        db.execute(
            "UPDATE mission_workspace SET state='cleanup_pending' WHERE id='workspace-b'",
            [],
        )
        .unwrap();
        assert_eq!(
            resolve_mission_remote_workspace(&db, &auth),
            Err(RpcErrorCode::NotFound)
        );
        db.execute(
            "UPDATE mission_workspace SET state='ready' WHERE id='workspace-b'",
            [],
        )
        .unwrap();
        db.execute(
            "UPDATE execution_node SET revoked_at='revoked' WHERE node_id='node-b'",
            [],
        )
        .unwrap();
        assert_eq!(
            resolve_mission_remote_workspace(&db, &auth),
            Err(RpcErrorCode::NotFound)
        );
        // A Run outside this camp reads the same closed answer, never another Mission's row.
        let mut foreign = auth.clone();
        foreign.camp_id = "other".into();
        assert_eq!(
            resolve_mission_remote_workspace(&db, &foreign),
            Err(RpcErrorCode::NotFound)
        );
    }

    #[test]
    fn actual_run_conversation_membership_and_ready_workspace_define_rpc_scope() {
        let (db, auth) = fixture();
        let (principal, grant) =
            resolve_workspace_authority(&db, &auth, "workspace", Some(4)).unwrap();
        let TrustedPrincipal::AgentRun(scope) = principal else {
            panic!("expected actual Run")
        };
        assert_eq!(scope.session_id, "session");
        assert_eq!(scope.attempt, 7);
        assert_eq!(scope.member_id, "member");
        assert_eq!(scope.mission_id, "mission");
        assert_eq!(grant.owner_node_id, "node-b");
        assert_eq!(grant.policy_revision, 3);
        let mut wrong = auth.clone();
        wrong.camp_id = "foreign".into();
        assert_eq!(
            resolve_workspace_authority(&db, &wrong, "workspace", Some(4)).unwrap_err(),
            RpcErrorCode::Unauthorized
        );
        wrong = auth.clone();
        wrong.execution_epoch = i64::MAX;
        assert_eq!(
            resolve_workspace_authority(&db, &wrong, "workspace", Some(4)).unwrap_err(),
            RpcErrorCode::Unauthorized
        );
        let dispatch = WorkspaceDispatch::new(
            WorkspaceRequest {
                version: RPC_VERSION,
                request_id: "request".into(),
                workspace_id: "workspace".into(),
                timeout_ms: 5000,
                operation: WorkspaceOperation::List {
                    path: String::new(),
                    limit: 10,
                },
            },
            scope,
            "node-b".into(),
            3,
            1000,
        )
        .unwrap();
        revalidate_dispatch(&db, &dispatch).unwrap();
        // The same mission workspace admits a write on the same scope, and the
        // dispatch itself still refuses an escaping or unwritable target.
        use base64::Engine as _;
        let write = WorkspaceDispatch::new(
            WorkspaceRequest {
                version: RPC_VERSION,
                request_id: "write".into(),
                workspace_id: "workspace".into(),
                timeout_ms: 5000,
                operation: WorkspaceOperation::Write {
                    path: "out/report.md".into(),
                    data: base64::engine::general_purpose::STANDARD.encode(b"done"),
                },
            },
            dispatch.scope.clone(),
            "node-b".into(),
            3,
            1000,
        )
        .unwrap();
        revalidate_dispatch(&db, &write).unwrap();
        let escaping = WorkspaceRequest {
            operation: WorkspaceOperation::Write {
                path: "../outside.md".into(),
                data: base64::engine::general_purpose::STANDARD.encode(b"done"),
            },
            ..write.request.clone()
        };
        assert_eq!(escaping.validate(), Err(RpcErrorCode::PathRejected));
        db.execute("UPDATE agent_run SET cancel_requested_at='requested'", [])
            .unwrap();
        assert_eq!(
            revalidate_dispatch(&db, &dispatch),
            Err(RpcErrorCode::Unauthorized)
        );
        db.execute("UPDATE agent_run SET cancel_requested_at=NULL", [])
            .unwrap();
        db.execute("UPDATE mission_workspace SET generation=4", [])
            .unwrap();
        assert_eq!(
            revalidate_dispatch(&db, &dispatch),
            Err(RpcErrorCode::PolicyMismatch)
        );
        db.execute("UPDATE mission_workspace SET generation=3", [])
            .unwrap();
        db.execute("UPDATE camp_member SET leave_requested_at='leaving'", [])
            .unwrap();
        assert_eq!(
            revalidate_dispatch(&db, &dispatch),
            Err(RpcErrorCode::Unauthorized)
        );
    }
}
