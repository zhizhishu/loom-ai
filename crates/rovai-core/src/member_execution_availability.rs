//! Read-only launch eligibility of the member's explicitly selected execution host.
//! Local runtime settings remain local facts. An explicit remote target never
//! falls back to those settings, including while offline or after catalog drift.

use anyhow::Result;
use chrono::{DateTime, Utc};
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;

use crate::{
    agent_profile::{
        AdapterKind, MemberRuntimeConfiguration, RuntimeReadiness, RuntimeReadinessBlocker,
        RuntimeReadinessStatus,
    },
    remote_catalog::RemoteCatalogError,
    remote_execution::{self, RemoteTargetError},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MemberExecutionLocation {
    Local,
    Remote,
}

/// Eligibility to attempt the next launch, not proof of provider authentication.
/// No local installation, program path, preparation token or native session is
/// synthesized by this projection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberExecutionAvailability {
    pub location: MemberExecutionLocation,
    pub configured: bool,
    pub can_launch: bool,
    pub adapter_kind: Option<AdapterKind>,
    pub readiness: RuntimeReadiness,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    pub target_revision: i64,
}

fn launch_eligible(readiness: &RuntimeReadiness) -> bool {
    matches!(
        readiness.status,
        RuntimeReadinessStatus::Ready
            | RuntimeReadinessStatus::LightReady
            | RuntimeReadinessStatus::InstalledUnverified
    )
}

fn local(
    configuration: Option<&MemberRuntimeConfiguration>,
    readiness: &RuntimeReadiness,
    target_revision: i64,
) -> MemberExecutionAvailability {
    MemberExecutionAvailability {
        location: MemberExecutionLocation::Local,
        configured: configuration.is_some(),
        can_launch: configuration.is_some() && launch_eligible(readiness),
        adapter_kind: configuration.map(|configuration| configuration.adapter_kind),
        readiness: readiness.clone(),
        node_id: None,
        workspace_id: None,
        target_revision,
    }
}

fn blocked(mut view: MemberExecutionAvailability, code: &str) -> MemberExecutionAvailability {
    view.can_launch = false;
    view.readiness = RuntimeReadiness {
        status: RuntimeReadinessStatus::NeedsAttention,
        blockers: vec![RuntimeReadinessBlocker {
            code: code.to_string(),
            detail: None,
        }],
    };
    view
}

pub(crate) fn evaluate(
    connection: &Connection,
    member_id: &str,
    local_configuration: Option<&MemberRuntimeConfiguration>,
    local_readiness: &RuntimeReadiness,
) -> Result<MemberExecutionAvailability> {
    evaluate_at(
        connection,
        member_id,
        local_configuration,
        local_readiness,
        Utc::now(),
    )
}

fn evaluate_at(
    connection: &Connection,
    member_id: &str,
    local_configuration: Option<&MemberRuntimeConfiguration>,
    local_readiness: &RuntimeReadiness,
    now: DateTime<Utc>,
) -> Result<MemberExecutionAvailability> {
    // Older data contracts cannot contain a remote choice. A current contract
    // missing this required table is corruption, not authority to choose local.
    if !remote_execution::authority_table_available(connection, "member_execution_target")
        .map_err(RemoteTargetError::from_error)?
    {
        return Ok(local(local_configuration, local_readiness, 0));
    }
    let target = remote_execution::load_member_target(connection, member_id)
        .map_err(RemoteTargetError::from_error)?;
    let Some(selection) = target.selection else {
        return Ok(local(local_configuration, local_readiness, target.revision));
    };
    let view = MemberExecutionAvailability {
        location: MemberExecutionLocation::Remote,
        configured: true,
        can_launch: false,
        adapter_kind: Some(selection.adapter_kind),
        readiness: RuntimeReadiness {
            status: RuntimeReadinessStatus::InstalledUnverified,
            blockers: Vec::new(),
        },
        node_id: Some(selection.node_id.clone()),
        workspace_id: Some(selection.workspace_id.clone()),
        target_revision: target.revision,
    };
    let node: Option<(String, Option<String>, Option<String>, Option<String>)> = connection
        .query_row(
            "SELECT role,session_opened_at,session_closed_at,revoked_at FROM execution_node WHERE node_id=?1",
            [&selection.node_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|_| RemoteCatalogError::CatalogUnavailable)?;
    let Some((role, session_opened_at, session_closed_at, revoked_at)) = node else {
        return Ok(blocked(view, RemoteCatalogError::NodeNotFound.code()));
    };
    if role != "remote" {
        return Ok(blocked(view, RemoteCatalogError::NodeNotRemote.code()));
    }
    if revoked_at.is_some() {
        return Ok(blocked(view, RemoteCatalogError::NodeRevoked.code()));
    }
    // Reuses the production permission/model, active source-Mission membership,
    // prepared-workspace and strong native catalog admission. No filesystem read
    // on A can establish the existence of a path on B.
    match remote_execution::validate_member_remote_selection(connection, member_id) {
        Ok(true) => {}
        Ok(false) => return Ok(blocked(view, "remote_target_revision_conflict")),
        Err(error) => return Ok(blocked(view, RemoteTargetError::from_error(error).code())),
    }
    // Presence is the session pair the Node's socket opened and closed, not a heartbeat
    // window (decision 2026-11-17-2215). `now` no longer decides whether it is present.
    let _ = now;
    if !crate::device_presence::is_device_online(&crate::device_presence::device_session_state(
        session_opened_at.as_deref(),
        session_closed_at.as_deref(),
    )) {
        return Ok(blocked(view, "remote_node_offline"));
    }
    Ok(MemberExecutionAvailability {
        can_launch: true,
        ..view
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_profile::{AdapterPermissionConfig, ModelSelection};
    use rusqlite::params;
    use serde_json::json;

    fn readiness(status: RuntimeReadinessStatus) -> RuntimeReadiness {
        RuntimeReadiness {
            status,
            blockers: Vec::new(),
        }
    }

    fn local_configuration() -> MemberRuntimeConfiguration {
        MemberRuntimeConfiguration {
            pi_purge: None,
            adapter_kind: AdapterKind::CodexCli,
            model: ModelSelection::RuntimeDefault,
            permissions: AdapterPermissionConfig {
                adapter_kind: AdapterKind::CodexCli,
                schema_version: 1,
                values: json!({}),
            },
        }
    }

    // A SQL read-model fixture, not a real Run, claim, lease or E2E identity.
    fn fixture() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE member_execution_target(member_id TEXT PRIMARY KEY, revision INTEGER, selection_json TEXT);
             CREATE TABLE execution_node(node_id TEXT PRIMARY KEY,role TEXT,last_heartbeat TEXT,revoked_at TEXT,session_opened_at TEXT,session_closed_at TEXT,session_socket_id TEXT);
             CREATE TABLE execution_node_cli(node_id TEXT,adapter_kind TEXT,path TEXT,version TEXT,path_present INTEGER,installation_identity TEXT,installation_generation INTEGER);
             CREATE TABLE mission(id TEXT PRIMARY KEY,camp_id TEXT);
             CREATE TABLE mission_workspace(id TEXT PRIMARY KEY,mission_id TEXT,camp_id TEXT,execution_host_id TEXT,worktree_path TEXT,generation INTEGER,preparation_token TEXT,state TEXT);
             CREATE TABLE camp_member(camp_id TEXT,agent_id TEXT,status TEXT,leave_requested_at TEXT);
             INSERT INTO mission VALUES('mission-source','camp-source');
             INSERT INTO mission_workspace VALUES('workspace-b','mission-source','camp-source','node-b','B:/prepared/worktree',1,'fixture-preparation','ready');
             INSERT INTO camp_member VALUES('camp-source','member','active',NULL);
             INSERT INTO execution_node VALUES('node-b','remote','2026-11-05T05:00:00Z',NULL,'2026-11-05T05:00:00Z',NULL,'fixture-socket');",
        ).unwrap();
        connection.execute(
            "INSERT INTO execution_node_cli VALUES('node-b','claude-code-cli','B:/native/claude.exe','2.1.241',1,?1,1)",
            [format!("sha256:{}", "a".repeat(64))],
        ).unwrap();
        connection
    }

    fn select_remote(connection: &Connection) {
        let defaults = crate::agent_profile::member_runtime_defaults(AdapterKind::ClaudeCodeCli);
        let selection = json!({
            "nodeId": "node-b", "workspaceId": "workspace-b",
            "workspaceRoot": "B:/prepared/worktree", "adapterKind": "claude-code-cli",
            "model": defaults.model,
            "permissions": defaults.permissions
        });
        connection
            .execute(
                "INSERT INTO member_execution_target VALUES('member',7,?1)",
                [selection.to_string()],
            )
            .unwrap();
    }

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-11-05T05:00:10Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn local_and_unconfigured_keep_the_original_local_facts() {
        let connection = fixture();
        let missing = readiness(RuntimeReadinessStatus::RuntimeNotConfigured);
        let none = evaluate_at(&connection, "member", None, &missing, now()).unwrap();
        assert_eq!(none.location, MemberExecutionLocation::Local);
        assert!(!none.configured && !none.can_launch);
        assert_eq!(none.readiness, missing);
        let local = local_configuration();
        let ready = readiness(RuntimeReadinessStatus::InstalledUnverified);
        let configured = evaluate_at(&connection, "member", Some(&local), &ready, now()).unwrap();
        assert!(configured.configured && configured.can_launch);
        assert_eq!(configured.adapter_kind, Some(AdapterKind::CodexCli));
        let denied = readiness(RuntimeReadinessStatus::NeedsAttention);
        assert!(
            !evaluate_at(&connection, "member", Some(&local), &denied, now())
                .unwrap()
                .can_launch
        );
    }

    #[test]
    fn remote_is_read_only_and_does_not_require_or_replace_a_local_runtime() {
        let connection = fixture();
        select_remote(&connection);
        let before = connection.total_changes();
        let no_local = readiness(RuntimeReadinessStatus::RuntimeNotConfigured);
        let remote = evaluate_at(&connection, "member", None, &no_local, now()).unwrap();
        assert_eq!(remote.location, MemberExecutionLocation::Remote);
        assert!(remote.configured && remote.can_launch);
        assert_eq!(remote.adapter_kind, Some(AdapterKind::ClaudeCodeCli));
        assert_eq!(remote.target_revision, 7);
        assert_eq!(
            remote.readiness.status,
            RuntimeReadinessStatus::InstalledUnverified
        );
        assert_eq!(connection.total_changes(), before);
        let dormant_local = local_configuration();
        let with_local = evaluate_at(
            &connection,
            "member",
            Some(&dormant_local),
            &readiness(RuntimeReadinessStatus::Ready),
            now(),
        )
        .unwrap();
        assert_eq!(with_local, remote);
        assert_eq!(dormant_local.adapter_kind, AdapterKind::CodexCli);
    }

    #[test]
    fn remote_offline_stays_configured_and_never_falls_back_to_ready_local() {
        let connection = fixture();
        select_remote(&connection);
        let local = local_configuration();
        for (opened, closed) in [
            (None, None),
            (Some("2026-11-05T05:00:00Z"), Some("2026-11-05T05:00:00Z")),
            (Some("2026-11-05T05:00:00Z"), Some("2026-11-05T06:00:00Z")),
        ] {
            connection
                .execute(
                    "UPDATE execution_node SET session_opened_at=?1, session_closed_at=?2",
                    params![opened, closed],
                )
                .unwrap();
            let view = evaluate_at(
                &connection,
                "member",
                Some(&local),
                &readiness(RuntimeReadinessStatus::Ready),
                now(),
            )
            .unwrap();
            assert_eq!(view.location, MemberExecutionLocation::Remote);
            assert!(view.configured && !view.can_launch);
            assert_eq!(view.node_id.as_deref(), Some("node-b"));
            assert_eq!(view.readiness.blockers[0].code, "remote_node_offline");
        }
    }

    #[test]
    fn revoked_workspace_drift_and_catalog_damage_are_closed_blockers() {
        for (sql, code) in [
            (
                "UPDATE execution_node SET revoked_at='revoked'",
                "remote_catalog_node_revoked",
            ),
            (
                "UPDATE mission_workspace SET worktree_path='B:/other'",
                "remote_target_workspace_changed",
            ),
            (
                "UPDATE mission_workspace SET state='failed'",
                "remote_target_workspace_unavailable",
            ),
            (
                "UPDATE camp_member SET status='left'",
                "remote_target_workspace_unavailable",
            ),
            (
                "UPDATE execution_node_cli SET path_present=0",
                "remote_catalog_program_unavailable",
            ),
            (
                "UPDATE execution_node_cli SET installation_identity='forged'",
                "remote_catalog_identity_malformed",
            ),
            (
                "UPDATE execution_node_cli SET installation_generation=0",
                "remote_catalog_generation_out_of_range",
            ),
        ] {
            let connection = fixture();
            select_remote(&connection);
            connection.execute_batch(sql).unwrap();
            let view = evaluate_at(
                &connection,
                "member",
                Some(&local_configuration()),
                &readiness(RuntimeReadinessStatus::Ready),
                now(),
            )
            .unwrap();
            assert!(view.configured && !view.can_launch, "{sql}");
            assert_eq!(view.location, MemberExecutionLocation::Remote);
            assert_eq!(view.readiness.blockers[0].code, code, "{sql}");
            assert_eq!(view.readiness.blockers[0].detail, None);
        }
    }

    #[test]
    fn corrupted_current_authority_does_not_become_an_implicit_local_choice() {
        let connection = fixture();
        select_remote(&connection);
        connection
            .execute(
                "UPDATE member_execution_target SET selection_json='not-json'",
                [],
            )
            .unwrap();
        let error = evaluate_at(
            &connection,
            "member",
            Some(&local_configuration()),
            &readiness(RuntimeReadinessStatus::Ready),
            now(),
        )
        .unwrap_err();
        assert_eq!(error.to_string(), "remote_target_storage_unavailable");
        connection.execute_batch(
            "CREATE TABLE rovai_data_contract(singleton INTEGER,projection_schema_version INTEGER);
             INSERT INTO rovai_data_contract VALUES(1,181);
             DROP TABLE member_execution_target;"
        ).unwrap();
        assert!(
            evaluate_at(
                &connection,
                "member",
                Some(&local_configuration()),
                &readiness(RuntimeReadinessStatus::Ready),
                now()
            )
            .is_err()
        );
    }
}
