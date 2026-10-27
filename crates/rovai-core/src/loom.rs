//! LOOM orchestration read side. Plans, tasks and dependency edges are read-only
//! facts for one Mission; every query is scoped by `missionId`.
use anyhow::{Context, Result};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use crate::db::Database;

/// LOOM control-plane task state machine: DRAFT → READY → BLOCKED → IN_REVIEW → DONE / CANCELED.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum LoomTaskStatus {
    Draft,
    Ready,
    Blocked,
    InReview,
    Done,
    Canceled,
}

impl LoomTaskStatus {
    fn parse(raw: &str) -> Result<Self> {
        match raw {
            "DRAFT" => Ok(Self::Draft),
            "READY" => Ok(Self::Ready),
            "BLOCKED" => Ok(Self::Blocked),
            "IN_REVIEW" => Ok(Self::InReview),
            "DONE" => Ok(Self::Done),
            "CANCELED" => Ok(Self::Canceled),
            other => anyhow::bail!("LOOM task has an unknown status {other}"),
        }
    }
}

/// Dependency release conditions: the upstream Task is done, or its artifact was accepted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum LoomDependencyCondition {
    TaskDone,
    ArtifactAccepted,
}

impl LoomDependencyCondition {
    fn parse(raw: &str) -> Result<Self> {
        match raw {
            "TASK_DONE" => Ok(Self::TaskDone),
            "ARTIFACT_ACCEPTED" => Ok(Self::ArtifactAccepted),
            other => anyhow::bail!("LOOM dependency has an unknown condition {other}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoomPlan {
    pub plan_id: String,
    pub mission_id: String,
    pub goal: String,
    pub acceptance_criteria: Vec<String>,
    pub created_at: String,
    pub revision: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoomTask {
    pub task_id: String,
    pub plan_id: String,
    pub title: String,
    pub description: String,
    pub assignee_agent_id: Option<String>,
    pub status: LoomTaskStatus,
    pub acceptance_criteria: Vec<String>,
    pub blocked_reason: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub revision: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoomDependency {
    pub dependency_id: String,
    pub plan_id: String,
    pub upstream_task_id: String,
    pub downstream_task_id: String,
    pub condition: LoomDependencyCondition,
    pub resolved_artifact_id: Option<String>,
    pub resolved_at: Option<String>,
    pub upstream_task_revision: Option<i64>,
    pub candidate_id: Option<String>,
    pub review_id: Option<String>,
    pub created_at: String,
}

/// Read input for every LOOM query; `missionId` is the only scope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MissionScopeInput {
    pub mission_id: String,
}

fn scoped_mission(mission_id: &str) -> Result<&str> {
    anyhow::ensure!(
        !mission_id.trim().is_empty(),
        "LOOM queries require a missionId"
    );
    Ok(mission_id)
}

fn criteria(raw: &str, owner: &str) -> Result<Vec<String>> {
    serde_json::from_str(raw)
        .with_context(|| format!("{owner} acceptance criteria are not a list"))
}

/// The authoritative plan for one Mission, if orchestration was configured.
pub fn plan_get(database: &Database, mission_id: &str) -> Result<Option<LoomPlan>> {
    let mission_id = scoped_mission(mission_id)?;
    let row: Option<(String, String, String, String, String, i64)> = database
        .connection()
        .query_row(
            "SELECT plan_id, mission_id, goal, acceptance_criteria_json, created_at, revision
             FROM loom_plan WHERE mission_id=?1",
            [mission_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .optional()?;
    row.map(
        |(plan_id, mission_id, goal, acceptance_criteria_json, created_at, revision)| {
            Ok(LoomPlan {
                acceptance_criteria: criteria(&acceptance_criteria_json, &plan_id)?,
                plan_id,
                mission_id,
                goal,
                created_at,
                revision,
            })
        },
    )
    .transpose()
}

/// Every Task of the Mission's plan, in creation order.
pub fn tasks_list(database: &Database, mission_id: &str) -> Result<Vec<LoomTask>> {
    let mission_id = scoped_mission(mission_id)?;
    let rows = database
        .connection()
        .prepare(
            "SELECT task.task_id, task.plan_id, task.title, task.description,
                    task.assignee_agent_id, task.status, task.acceptance_criteria_json,
                    task.blocked_reason, task.created_at, task.updated_at, task.revision
             FROM loom_task AS task
             JOIN loom_plan AS plan ON plan.plan_id=task.plan_id
             WHERE plan.mission_id=?1
             ORDER BY task.created_at, task.task_id",
        )?
        .query_map([mission_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, String>(9)?,
                row.get::<_, i64>(10)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(
            |(
                task_id,
                plan_id,
                title,
                description,
                assignee_agent_id,
                status,
                acceptance_criteria_json,
                blocked_reason,
                created_at,
                updated_at,
                revision,
            )| {
                Ok(LoomTask {
                    status: LoomTaskStatus::parse(&status)?,
                    acceptance_criteria: criteria(&acceptance_criteria_json, &task_id)?,
                    task_id,
                    plan_id,
                    title,
                    description,
                    assignee_agent_id,
                    blocked_reason,
                    created_at,
                    updated_at,
                    revision,
                })
            },
        )
        .collect()
}

/// Every dependency edge of the Mission's plan, in creation order.
pub fn dependencies_list(database: &Database, mission_id: &str) -> Result<Vec<LoomDependency>> {
    let mission_id = scoped_mission(mission_id)?;
    let rows = database
        .connection()
        .prepare(
            "SELECT dependency.dependency_id, dependency.plan_id, dependency.upstream_task_id,
                    dependency.downstream_task_id, dependency.condition,
                    dependency.resolved_artifact_id, dependency.resolved_at,
                    dependency.upstream_task_revision, dependency.candidate_id,
                    dependency.review_id, dependency.created_at
             FROM loom_dependency AS dependency
             JOIN loom_plan AS plan ON plan.plan_id=dependency.plan_id
             WHERE plan.mission_id=?1
             ORDER BY dependency.created_at, dependency.dependency_id",
        )?
        .query_map([mission_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<i64>>(7)?,
                row.get::<_, Option<String>>(8)?,
                row.get::<_, Option<String>>(9)?,
                row.get::<_, String>(10)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(
            |(
                dependency_id,
                plan_id,
                upstream_task_id,
                downstream_task_id,
                condition,
                resolved_artifact_id,
                resolved_at,
                upstream_task_revision,
                candidate_id,
                review_id,
                created_at,
            )| {
                Ok(LoomDependency {
                    condition: LoomDependencyCondition::parse(&condition)?,
                    dependency_id,
                    plan_id,
                    upstream_task_id,
                    downstream_task_id,
                    resolved_artifact_id,
                    resolved_at,
                    upstream_task_revision,
                    candidate_id,
                    review_id,
                    created_at,
                })
            },
        )
        .collect()
}
