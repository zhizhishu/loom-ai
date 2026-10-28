//! LOOM orchestration. Plans, tasks and dependency edges are read-only facts for one
//! Mission; every query is scoped by `missionId`. The write paths are [`plan_import`],
//! [`task_release`], [`claim_acquire`] and [`candidate_record`], each one Mission, one
//! transaction.
use std::collections::{HashMap, HashSet};

use anyhow::{Context, Result};
use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};

use crate::db::Database;

/// LOOM control-plane task state machine: DRAFT → READY → BLOCKED → IN_REVIEW → DONE / CANCELED.
/// The persisted literals stay uppercase; the wire shape is the contract's lowercase one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
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
/// The persisted literals stay uppercase; the wire shape is the contract's lowercase one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
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

    fn as_str(self) -> &'static str {
        match self {
            Self::TaskDone => "TASK_DONE",
            Self::ArtifactAccepted => "ARTIFACT_ACCEPTED",
        }
    }
}

/// One acceptance criterion on the wire; `criterionId` is the stable identity every
/// verdict binds to, never the array position.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoomAcceptanceCriterion {
    pub criterion_id: String,
    pub text: String,
}

/// Acceptance criteria snapshot: the Plan defines the version and every Task of the
/// Plan inherits the same one, so a verdict can be bound to a frozen version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoomAcceptanceCriteriaSnapshot {
    pub version: String,
    pub criteria: Vec<LoomAcceptanceCriterion>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoomPlan {
    pub plan_id: String,
    pub mission_id: String,
    pub goal: String,
    pub acceptance_criteria: LoomAcceptanceCriteriaSnapshot,
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
    pub acceptance_criteria: LoomAcceptanceCriteriaSnapshot,
    pub blocked_reason: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub revision: i64,
}

/// Frozen release trace: written once when a dependency first resolves and never
/// upgraded afterwards.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoomDependencyResolution {
    pub resolved_at: String,
    pub upstream_task_revision: i64,
    pub candidate_id: Option<String>,
    pub review_id: Option<String>,
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
    pub resolution: Option<LoomDependencyResolution>,
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

/// Persisted acceptance criteria are `{criterionId,text}` rows; the read model adds the
/// Plan-level version every Task inherits to form the snapshot.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredCriterion {
    criterion_id: String,
    text: String,
}

fn criteria_snapshot(
    raw: &str,
    version: &str,
    owner: &str,
) -> Result<LoomAcceptanceCriteriaSnapshot> {
    let stored: Vec<StoredCriterion> = serde_json::from_str(raw).with_context(|| {
        format!("{owner} acceptance criteria are not a list of {{criterionId,text}} rows")
    })?;
    Ok(LoomAcceptanceCriteriaSnapshot {
        version: version.to_string(),
        criteria: stored
            .into_iter()
            .map(|criterion| LoomAcceptanceCriterion {
                criterion_id: criterion.criterion_id,
                text: criterion.text,
            })
            .collect(),
    })
}

/// A frozen release trace exists only once the database recorded both the release
/// moment and the upstream revision; a half-written trace is not a release.
fn resolution(
    resolved_at: Option<String>,
    upstream_task_revision: Option<i64>,
    candidate_id: Option<String>,
    review_id: Option<String>,
) -> Option<LoomDependencyResolution> {
    let resolved_at = resolved_at?;
    let upstream_task_revision = upstream_task_revision?;
    Some(LoomDependencyResolution {
        resolved_at,
        upstream_task_revision,
        candidate_id,
        review_id,
    })
}

/// The authoritative plan for one Mission, if orchestration was configured.
pub fn plan_get(database: &Database, mission_id: &str) -> Result<Option<LoomPlan>> {
    let mission_id = scoped_mission(mission_id)?;
    let row: Option<(String, String, String, String, String, String, i64)> = database
        .connection()
        .query_row(
            "SELECT plan_id, mission_id, goal, acceptance_criteria_json,
                    acceptance_criteria_version, created_at, revision
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
                    row.get(6)?,
                ))
            },
        )
        .optional()?;
    row.map(
        |(
            plan_id,
            mission_id,
            goal,
            acceptance_criteria_json,
            acceptance_criteria_version,
            created_at,
            revision,
        )| {
            Ok(LoomPlan {
                acceptance_criteria: criteria_snapshot(
                    &acceptance_criteria_json,
                    &acceptance_criteria_version,
                    &plan_id,
                )?,
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
                    plan.acceptance_criteria_version, task.blocked_reason, task.created_at,
                    task.updated_at, task.revision
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
                row.get::<_, String>(7)?,
                row.get::<_, Option<String>>(8)?,
                row.get::<_, String>(9)?,
                row.get::<_, String>(10)?,
                row.get::<_, i64>(11)?,
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
                acceptance_criteria_version,
                blocked_reason,
                created_at,
                updated_at,
                revision,
            )| {
                Ok(LoomTask {
                    status: LoomTaskStatus::parse(&status)?,
                    acceptance_criteria: criteria_snapshot(
                        &acceptance_criteria_json,
                        &acceptance_criteria_version,
                        &task_id,
                    )?,
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
                    resolution: resolution(
                        resolved_at,
                        upstream_task_revision,
                        candidate_id,
                        review_id,
                    ),
                    dependency_id,
                    plan_id,
                    upstream_task_id,
                    downstream_task_id,
                    resolved_artifact_id,
                    created_at,
                })
            },
        )
        .collect()
}

/// Import input: one Mission gains exactly one Plan with its Task set and DAG edges.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoomPlanImportInput {
    pub mission_id: String,
    pub goal: String,
    pub acceptance_criteria_version: String,
    pub criteria: Vec<LoomPlanImportCriterion>,
    pub tasks: Vec<LoomPlanImportTask>,
    pub dependencies: Vec<LoomPlanImportDependency>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoomPlanImportCriterion {
    pub criterion_id: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoomPlanImportTask {
    pub task_id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub assignee_agent_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoomPlanImportDependency {
    pub upstream_task_id: String,
    pub downstream_task_id: String,
    /// Defaults to `TASK_DONE`.
    #[serde(default)]
    pub condition: Option<LoomDependencyCondition>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoomPlanImportResult {
    pub plan_id: String,
    pub mission_id: String,
    pub acceptance_criteria_version: String,
    pub task_ids: Vec<String>,
    pub dependency_ids: Vec<String>,
}

/// Rejection of a LOOM plan import; `code` is the stable error code the Host returns.
#[derive(Debug)]
pub struct LoomPlanImportError {
    code: &'static str,
    message: String,
}

impl LoomPlanImportError {
    fn rejection(code: &'static str, message: impl Into<String>) -> anyhow::Error {
        anyhow::Error::new(Self {
            code,
            message: message.into(),
        })
    }

    pub fn code(&self) -> &'static str {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl std::fmt::Display for LoomPlanImportError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for LoomPlanImportError {}

const LOOM_INVALID_INPUT: &str = "LOOM_INVALID_INPUT";
const LOOM_MISSION_NOT_FOUND: &str = "LOOM_MISSION_NOT_FOUND";
const LOOM_PLAN_EXISTS: &str = "LOOM_PLAN_EXISTS";
const LOOM_TASK_DUPLICATE: &str = "LOOM_TASK_DUPLICATE";
const LOOM_TASK_EXISTS: &str = "LOOM_TASK_EXISTS";
const LOOM_CRITERION_DUPLICATE: &str = "LOOM_CRITERION_DUPLICATE";
const LOOM_DEPENDENCY_TASK_MISSING: &str = "LOOM_DEPENDENCY_TASK_MISSING";
const LOOM_DEPENDENCY_SELF: &str = "LOOM_DEPENDENCY_SELF";
const LOOM_DEPENDENCY_DUPLICATE: &str = "LOOM_DEPENDENCY_DUPLICATE";
const LOOM_DAG_CYCLE: &str = "LOOM_DAG_CYCLE";
const LOOM_PLAN_NOT_FOUND: &str = "LOOM_PLAN_NOT_FOUND";
const LOOM_TASK_NOT_FOUND: &str = "LOOM_TASK_NOT_FOUND";
const LOOM_TASK_NOT_DRAFT: &str = "LOOM_TASK_NOT_DRAFT";
const LOOM_TASK_NOT_READY: &str = "LOOM_TASK_NOT_READY";
const LOOM_DEPENDENCY_UNRELEASED: &str = "LOOM_DEPENDENCY_UNRELEASED";
const LOOM_CLAIM_HELD: &str = "LOOM_CLAIM_HELD";
const LOOM_CLAIM_COMMAND_REUSED: &str = "LOOM_CLAIM_COMMAND_REUSED";
const LOOM_CLAIM_ABSENT: &str = "LOOM_CLAIM_ABSENT";
const LOOM_CLAIM_EXPIRED: &str = "LOOM_CLAIM_EXPIRED";
const LOOM_CLAIM_AGENT_RUN_MISMATCH: &str = "LOOM_CLAIM_AGENT_RUN_MISMATCH";
const LOOM_ACCEPTANCE_CRITERIA_VERSION_MISMATCH: &str =
    "LOOM_ACCEPTANCE_CRITERIA_VERSION_MISMATCH";
const LOOM_CANDIDATE_COMMAND_REUSED: &str = "LOOM_CANDIDATE_COMMAND_REUSED";
const LOOM_CANDIDATE_PREVIOUS_INVALID: &str = "LOOM_CANDIDATE_PREVIOUS_INVALID";

/// Rejection of a LOOM task release or claim; `code` is the stable error code the Host
/// returns, exactly like [`LoomPlanImportError`].
#[derive(Debug)]
pub struct LoomCommandError {
    code: &'static str,
    message: String,
}

impl LoomCommandError {
    fn rejection(code: &'static str, message: impl Into<String>) -> anyhow::Error {
        anyhow::Error::new(Self {
            code,
            message: message.into(),
        })
    }

    pub fn code(&self) -> &'static str {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl std::fmt::Display for LoomCommandError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for LoomCommandError {}

/// Persisted shape of one acceptance criterion; `criterionId` is the stable identity.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedCriterion<'a> {
    criterion_id: &'a str,
    text: &'a str,
}

struct ImportedTask<'a> {
    task_id: &'a str,
    title: &'a str,
    description: &'a str,
    assignee_agent_id: Option<&'a str>,
}

/// Three-colour DFS over the submitted edges (WHITE unvisited, GRAY on the current
/// path, BLACK finished). Returns the first cycle as a task path, if any.
fn find_plan_cycle<'a>(task_ids: &[&'a str], edges: &[(&'a str, &'a str)]) -> Option<Vec<String>> {
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Colour {
        White,
        Gray,
        Black,
    }

    fn visit<'a>(
        node: &'a str,
        adjacency: &HashMap<&'a str, Vec<&'a str>>,
        colour: &mut HashMap<&'a str, Colour>,
        path: &mut Vec<&'a str>,
    ) -> Option<Vec<String>> {
        colour.insert(node, Colour::Gray);
        path.push(node);
        if let Some(successors) = adjacency.get(node) {
            for successor in successors {
                let successor = *successor;
                match colour.get(successor).copied().unwrap_or(Colour::White) {
                    Colour::Gray => {
                        let start = path
                            .iter()
                            .position(|task_id| *task_id == successor)
                            .unwrap_or(0);
                        let mut cycle = path[start..]
                            .iter()
                            .map(|task_id| (*task_id).to_string())
                            .collect::<Vec<_>>();
                        cycle.push(successor.to_string());
                        return Some(cycle);
                    }
                    Colour::White => {
                        if let Some(cycle) = visit(successor, adjacency, colour, path) {
                            return Some(cycle);
                        }
                    }
                    Colour::Black => {}
                }
            }
        }
        path.pop();
        colour.insert(node, Colour::Black);
        None
    }

    let mut adjacency: HashMap<&'a str, Vec<&'a str>> = HashMap::new();
    for (upstream, downstream) in edges {
        adjacency.entry(*upstream).or_default().push(*downstream);
    }
    let mut colour: HashMap<&'a str, Colour> = task_ids
        .iter()
        .map(|task_id| (*task_id, Colour::White))
        .collect();
    let mut path: Vec<&'a str> = Vec::new();
    for task_id in task_ids {
        if colour.get(*task_id).copied() != Some(Colour::White) {
            continue;
        }
        if let Some(cycle) = visit(task_id, &adjacency, &mut colour, &mut path) {
            return Some(cycle);
        }
    }
    None
}

/// LOOM write path. Importing a plan is the only way a Mission gains orchestration
/// facts: the whole graph is validated first, then the plan, its tasks and its
/// dependency edges are written in one transaction, so a rejected import leaves no
/// half graph behind.
pub fn plan_import(
    database: &mut Database,
    input: LoomPlanImportInput,
) -> Result<LoomPlanImportResult> {
    let mission_id = input.mission_id.trim();
    if mission_id.is_empty() {
        return Err(LoomPlanImportError::rejection(
            LOOM_INVALID_INPUT,
            "LOOM plan import requires a missionId",
        ));
    }
    let goal = input.goal.trim();
    if goal.is_empty() || goal.chars().count() > 4000 {
        return Err(LoomPlanImportError::rejection(
            LOOM_INVALID_INPUT,
            "LOOM plan goal must be 1 to 4000 characters",
        ));
    }
    let acceptance_criteria_version = input.acceptance_criteria_version.trim();
    if acceptance_criteria_version.is_empty() {
        return Err(LoomPlanImportError::rejection(
            LOOM_INVALID_INPUT,
            "LOOM plan import requires an acceptanceCriteriaVersion",
        ));
    }

    let mut criterion_ids: HashSet<&str> = HashSet::new();
    let mut criteria_rows: Vec<ImportedCriterion<'_>> = Vec::with_capacity(input.criteria.len());
    for criterion in &input.criteria {
        let criterion_id = criterion.criterion_id.trim();
        if criterion_id.is_empty() {
            return Err(LoomPlanImportError::rejection(
                LOOM_INVALID_INPUT,
                "every acceptance criterion requires a criterionId",
            ));
        }
        if !criterion_ids.insert(criterion_id) {
            return Err(LoomPlanImportError::rejection(
                LOOM_CRITERION_DUPLICATE,
                format!("criterionId {criterion_id} is submitted more than once"),
            ));
        }
        criteria_rows.push(ImportedCriterion {
            criterion_id,
            text: criterion.text.trim(),
        });
    }
    let acceptance_criteria_json = serde_json::to_string(&criteria_rows)?;

    let mut task_rows: Vec<ImportedTask<'_>> = Vec::with_capacity(input.tasks.len());
    for task in &input.tasks {
        let task_id = task.task_id.trim();
        if task_id.is_empty() {
            return Err(LoomPlanImportError::rejection(
                LOOM_INVALID_INPUT,
                "every LOOM task requires a taskId",
            ));
        }
        if task_rows.iter().any(|row| row.task_id == task_id) {
            return Err(LoomPlanImportError::rejection(
                LOOM_TASK_DUPLICATE,
                format!("taskId {task_id} is submitted more than once"),
            ));
        }
        let title = task.title.trim();
        if title.is_empty() || title.chars().count() > 200 {
            return Err(LoomPlanImportError::rejection(
                LOOM_INVALID_INPUT,
                format!("LOOM task {task_id} title must be 1 to 200 characters"),
            ));
        }
        if task.description.chars().count() > 16000 {
            return Err(LoomPlanImportError::rejection(
                LOOM_INVALID_INPUT,
                format!("LOOM task {task_id} description exceeds 16000 characters"),
            ));
        }
        task_rows.push(ImportedTask {
            task_id,
            title,
            description: task.description.trim(),
            assignee_agent_id: task
                .assignee_agent_id
                .as_deref()
                .map(str::trim)
                .filter(|agent_id| !agent_id.is_empty()),
        });
    }

    let plan_task_ids = task_rows.iter().map(|task| task.task_id).collect::<Vec<_>>();
    let mut edges: Vec<(&str, &str)> = Vec::with_capacity(input.dependencies.len());
    let mut conditioned_edges: Vec<(&str, &str, LoomDependencyCondition)> =
        Vec::with_capacity(input.dependencies.len());
    let mut seen_edges: HashSet<(&str, &str)> = HashSet::new();
    for dependency in &input.dependencies {
        let upstream = dependency.upstream_task_id.trim();
        let downstream = dependency.downstream_task_id.trim();
        if !plan_task_ids.contains(&upstream) || !plan_task_ids.contains(&downstream) {
            return Err(LoomPlanImportError::rejection(
                LOOM_DEPENDENCY_TASK_MISSING,
                format!(
                    "dependency {upstream} -> {downstream} does not resolve inside the imported plan"
                ),
            ));
        }
        if upstream == downstream {
            return Err(LoomPlanImportError::rejection(
                LOOM_DEPENDENCY_SELF,
                format!("task {upstream} cannot depend on itself"),
            ));
        }
        if !seen_edges.insert((upstream, downstream)) {
            return Err(LoomPlanImportError::rejection(
                LOOM_DEPENDENCY_DUPLICATE,
                format!("dependency {upstream} -> {downstream} is submitted more than once"),
            ));
        }
        edges.push((upstream, downstream));
        conditioned_edges.push((
            upstream,
            downstream,
            dependency.condition.unwrap_or(LoomDependencyCondition::TaskDone),
        ));
    }
    if let Some(cycle) = find_plan_cycle(&plan_task_ids, &edges) {
        return Err(LoomPlanImportError::rejection(
            LOOM_DAG_CYCLE,
            format!("LOOM dependency cycle: {}", cycle.join(" -> ")),
        ));
    }

    let plan_id = format!("plan_{}", uuid::Uuid::new_v4().simple());
    let now = chrono::Utc::now().to_rfc3339();
    let transaction = database
        .connection_mut()
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mission_exists: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM mission WHERE id=?1)",
        [mission_id],
        |row| row.get(0),
    )?;
    if !mission_exists {
        return Err(LoomPlanImportError::rejection(
            LOOM_MISSION_NOT_FOUND,
            format!("mission {mission_id} does not exist"),
        ));
    }
    let existing_plan: Option<String> = transaction
        .query_row(
            "SELECT plan_id FROM loom_plan WHERE mission_id=?1",
            [mission_id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(existing_plan) = existing_plan {
        return Err(LoomPlanImportError::rejection(
            LOOM_PLAN_EXISTS,
            format!("mission {mission_id} is already planned by {existing_plan}"),
        ));
    }
    for task_id in &plan_task_ids {
        let taken: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM loom_task WHERE task_id=?1)",
            [task_id],
            |row| row.get(0),
        )?;
        if taken {
            return Err(LoomPlanImportError::rejection(
                LOOM_TASK_EXISTS,
                format!("taskId {task_id} already belongs to another LOOM plan"),
            ));
        }
    }

    transaction.execute(
        "INSERT INTO loom_plan(plan_id,mission_id,goal,acceptance_criteria_json,
                              acceptance_criteria_version,created_at,revision)
         VALUES(?1,?2,?3,?4,?5,?6,1)",
        params![
            &plan_id,
            mission_id,
            goal,
            &acceptance_criteria_json,
            acceptance_criteria_version,
            &now
        ],
    )?;
    for task in &task_rows {
        transaction.execute(
            "INSERT INTO loom_task(task_id,plan_id,title,description,assignee_agent_id,status,
                                  acceptance_criteria_json,created_at,updated_at,revision)
             VALUES(?1,?2,?3,?4,?5,'DRAFT',?6,?7,?7,1)",
            params![
                task.task_id,
                &plan_id,
                task.title,
                task.description,
                task.assignee_agent_id,
                &acceptance_criteria_json,
                &now,
            ],
        )?;
    }
    let mut dependency_ids = Vec::with_capacity(conditioned_edges.len());
    for (ordinal, (upstream, downstream, condition)) in conditioned_edges.into_iter().enumerate() {
        // Task IDs are opaque and may contain the "->" separator itself, so an edge ID
        // composed from the endpoint names can collide (a -> b->c vs a->b -> c). The plan
        // allows exactly one import, so a submission-order ordinal is unique and stable.
        let dependency_id = format!("{plan_id}:dep-{ordinal}");
        transaction.execute(
            "INSERT INTO loom_dependency(dependency_id,plan_id,upstream_task_id,
                                        downstream_task_id,condition,created_at)
             VALUES(?1,?2,?3,?4,?5,?6)",
            params![
                &dependency_id,
                &plan_id,
                upstream,
                downstream,
                condition.as_str(),
                &now,
            ],
        )?;
        dependency_ids.push(dependency_id);
    }
    transaction.commit()?;

    Ok(LoomPlanImportResult {
        plan_id,
        mission_id: mission_id.to_string(),
        acceptance_criteria_version: acceptance_criteria_version.to_string(),
        task_ids: plan_task_ids.into_iter().map(str::to_string).collect(),
        dependency_ids,
    })
}

/// Release input: the Mission-scoped Task that becomes `READY` for claiming.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoomTaskReleaseInput {
    pub mission_id: String,
    pub task_id: String,
}

/// Release receipt: the Task as it now stands, so the caller reads back the state change.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoomTaskReleaseResult {
    pub mission_id: String,
    pub plan_id: String,
    pub task: LoomTask,
}

/// Claim input. `commandId` is the idempotency key: replaying it returns the original
/// binding instead of writing a second claim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoomClaimAcquireInput {
    pub mission_id: String,
    pub task_id: String,
    pub agent_run_id: String,
    #[serde(default)]
    pub claimant_agent_id: Option<String>,
    pub command_id: String,
    /// Lease length in seconds; defaults to [`DEFAULT_CLAIM_LEASE_SECONDS`].
    #[serde(default)]
    pub lease_seconds: Option<i64>,
}

/// Claim receipt: the binding a Run holds on the Task, plus the fence it must present.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoomClaimAcquireResult {
    pub claim_id: String,
    pub mission_id: String,
    pub plan_id: String,
    pub task_id: String,
    pub agent_run_id: String,
    pub claimant_agent_id: Option<String>,
    pub fence_generation: i64,
    pub claimed_at: String,
    pub lease_expires_at: String,
    pub released_at: Option<String>,
    /// True when the same `commandId` replayed and no new claim was written.
    pub replayed: bool,
}

const DEFAULT_CLAIM_LEASE_SECONDS: i64 = 300;
const MAX_CLAIM_LEASE_SECONDS: i64 = 3600;

fn required_field(operation: &str, field: &str, value: &str) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(LoomCommandError::rejection(
            LOOM_INVALID_INPUT,
            format!("LOOM {operation} requires a {field}"),
        ));
    }
    Ok(trimmed.to_string())
}

/// One persisted claim; the row keeps the fence so a late holder can be fenced off.
struct StoredClaim {
    claim_id: String,
    plan_id: String,
    task_id: String,
    agent_run_id: String,
    claimant_agent_id: Option<String>,
    fence_generation: i64,
    claimed_at: String,
    lease_expires_at: String,
    released_at: Option<String>,
}

impl StoredClaim {
    fn read(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            claim_id: row.get(0)?,
            plan_id: row.get(1)?,
            task_id: row.get(2)?,
            agent_run_id: row.get(3)?,
            claimant_agent_id: row.get(4)?,
            fence_generation: row.get(5)?,
            claimed_at: row.get(6)?,
            lease_expires_at: row.get(7)?,
            released_at: row.get(8)?,
        })
    }

    fn into_result(self, mission_id: &str, replayed: bool) -> LoomClaimAcquireResult {
        LoomClaimAcquireResult {
            claim_id: self.claim_id,
            mission_id: mission_id.to_string(),
            plan_id: self.plan_id,
            task_id: self.task_id,
            agent_run_id: self.agent_run_id,
            claimant_agent_id: self.claimant_agent_id,
            fence_generation: self.fence_generation,
            claimed_at: self.claimed_at,
            lease_expires_at: self.lease_expires_at,
            released_at: self.released_at,
            replayed,
        }
    }
}

/// A lease is live only while it parses and lies in the future; an unreadable value is not
/// proof of a live lease, so a takeover fences it instead of trusting it.
fn lease_expired(lease_expires_at: &str, now: chrono::DateTime<chrono::Utc>) -> bool {
    match chrono::DateTime::parse_from_rfc3339(lease_expires_at) {
        Ok(expires) => expires.with_timezone(&chrono::Utc) <= now,
        Err(_) => true,
    }
}

/// The edges that still block a claim, using the same rule as the contract's
/// `loomEvaluateDependency`: a frozen release wins, otherwise a `TASK_DONE` edge needs its
/// upstream Task `DONE`. The `ARTIFACT_ACCEPTED` branch needs a candidate and an accepted
/// review, which this projection does not hold yet, so an unresolved artifact edge stays
/// unreleased.
fn blocking_dependencies(
    transaction: &rusqlite::Transaction<'_>,
    plan_id: &str,
    task_id: &str,
) -> Result<Vec<String>> {
    let rows = transaction
        .prepare(
            "SELECT dependency.dependency_id, dependency.condition, dependency.resolved_at,
                    upstream.status
             FROM loom_dependency AS dependency
             JOIN loom_task AS upstream
               ON upstream.plan_id=dependency.plan_id
              AND upstream.task_id=dependency.upstream_task_id
             WHERE dependency.plan_id=?1 AND dependency.downstream_task_id=?2
             ORDER BY dependency.created_at, dependency.dependency_id",
        )?
        .query_map(params![plan_id, task_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut blocking = Vec::new();
    for (dependency_id, condition, resolved_at, upstream_status) in rows {
        if resolved_at.is_some() {
            continue;
        }
        if upstream_status != "DONE" {
            blocking.push(format!("{dependency_id}:upstream_task_not_done"));
        } else if condition != LoomDependencyCondition::TaskDone.as_str() {
            blocking.push(format!("{dependency_id}:artifact_not_accepted"));
        }
    }
    Ok(blocking)
}

/// LOOM release path: a Task the Plan already defines becomes `READY` inside the Mission
/// that owns its Plan, and nothing else about it moves.
pub fn task_release(
    database: &mut Database,
    input: LoomTaskReleaseInput,
) -> Result<LoomTaskReleaseResult> {
    let mission_id = required_field("task release", "missionId", &input.mission_id)?;
    let task_id = required_field("task release", "taskId", &input.task_id)?;
    let now = chrono::Utc::now().to_rfc3339();
    let transaction = database
        .connection_mut()
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mission_exists: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM mission WHERE id=?1)",
        [&mission_id],
        |row| row.get(0),
    )?;
    if !mission_exists {
        return Err(LoomCommandError::rejection(
            LOOM_MISSION_NOT_FOUND,
            format!("mission {mission_id} does not exist"),
        ));
    }
    let plan_id: Option<String> = transaction
        .query_row(
            "SELECT plan_id FROM loom_plan WHERE mission_id=?1",
            [&mission_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(plan_id) = plan_id else {
        return Err(LoomCommandError::rejection(
            LOOM_PLAN_NOT_FOUND,
            format!("mission {mission_id} has no LOOM plan"),
        ));
    };
    let status: Option<String> = transaction
        .query_row(
            "SELECT status FROM loom_task WHERE plan_id=?1 AND task_id=?2",
            params![&plan_id, &task_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(status) = status else {
        return Err(LoomCommandError::rejection(
            LOOM_TASK_NOT_FOUND,
            format!("task {task_id} does not belong to the plan of mission {mission_id}"),
        ));
    };
    if status != "DRAFT" {
        return Err(LoomCommandError::rejection(
            LOOM_TASK_NOT_DRAFT,
            format!("LOOM task {task_id} is {status}; only a DRAFT task can be released"),
        ));
    }
    transaction.execute(
        "UPDATE loom_task SET status='READY', updated_at=?1, revision=revision+1
         WHERE plan_id=?2 AND task_id=?3",
        params![&now, &plan_id, &task_id],
    )?;
    transaction.commit()?;
    let task = tasks_list(&*database, &mission_id)?
        .into_iter()
        .find(|task| task.task_id == task_id)
        .ok_or_else(|| {
            LoomCommandError::rejection(
                LOOM_TASK_NOT_FOUND,
                format!("released task {task_id} is not readable"),
            )
        })?;
    Ok(LoomTaskReleaseResult {
        mission_id,
        plan_id,
        task,
    })
}

/// LOOM claim path: one Task, one Run, one lease. Everything the claim depends on
/// (Mission, Plan ownership, Task state, dependency release, the previous lease) is
/// checked and written in one immediate transaction, so a rejected or failed claim leaves
/// no half binding behind; `commandId` makes a replay return the original claim.
pub fn claim_acquire(
    database: &mut Database,
    input: LoomClaimAcquireInput,
) -> Result<LoomClaimAcquireResult> {
    let mission_id = required_field("claim acquire", "missionId", &input.mission_id)?;
    let task_id = required_field("claim acquire", "taskId", &input.task_id)?;
    let agent_run_id = required_field("claim acquire", "agentRunId", &input.agent_run_id)?;
    let command_id = required_field("claim acquire", "commandId", &input.command_id)?;
    let claimant_agent_id = input
        .claimant_agent_id
        .as_deref()
        .map(str::trim)
        .filter(|agent_id| !agent_id.is_empty())
        .map(str::to_string);
    let lease_seconds = input.lease_seconds.unwrap_or(DEFAULT_CLAIM_LEASE_SECONDS);
    if !(1..=MAX_CLAIM_LEASE_SECONDS).contains(&lease_seconds) {
        return Err(LoomCommandError::rejection(
            LOOM_INVALID_INPUT,
            format!("LOOM claim leaseSeconds must be 1 to {MAX_CLAIM_LEASE_SECONDS}"),
        ));
    }
    let now = chrono::Utc::now();
    let claimed_at = now.to_rfc3339();
    let lease_expires_at = (now + chrono::Duration::seconds(lease_seconds)).to_rfc3339();

    let transaction = database
        .connection_mut()
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mission_exists: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM mission WHERE id=?1)",
        [&mission_id],
        |row| row.get(0),
    )?;
    if !mission_exists {
        return Err(LoomCommandError::rejection(
            LOOM_MISSION_NOT_FOUND,
            format!("mission {mission_id} does not exist"),
        ));
    }
    let plan_id: Option<String> = transaction
        .query_row(
            "SELECT plan_id FROM loom_plan WHERE mission_id=?1",
            [&mission_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(plan_id) = plan_id else {
        return Err(LoomCommandError::rejection(
            LOOM_PLAN_NOT_FOUND,
            format!("mission {mission_id} has no LOOM plan"),
        ));
    };
    let status: Option<String> = transaction
        .query_row(
            "SELECT status FROM loom_task WHERE plan_id=?1 AND task_id=?2",
            params![&plan_id, &task_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(status) = status else {
        return Err(LoomCommandError::rejection(
            LOOM_TASK_NOT_FOUND,
            format!("task {task_id} does not belong to the plan of mission {mission_id}"),
        ));
    };

    // A replay must not depend on the current Task state: it returns the binding the
    // command already created, and only for the same Task and Run.
    let replay: Option<StoredClaim> = transaction
        .query_row(
            "SELECT claim_id, plan_id, task_id, agent_run_id, claimant_agent_id,
                    fence_generation, claimed_at, lease_expires_at, released_at
             FROM loom_claim WHERE command_id=?1",
            [&command_id],
            StoredClaim::read,
        )
        .optional()?;
    if let Some(claim) = replay {
        if claim.task_id != task_id || claim.agent_run_id != agent_run_id {
            return Err(LoomCommandError::rejection(
                LOOM_CLAIM_COMMAND_REUSED,
                format!(
                    "commandId {command_id} already bound task {} to agentRun {}",
                    claim.task_id, claim.agent_run_id
                ),
            ));
        }
        return Ok(claim.into_result(&mission_id, true));
    }

    if status != "READY" {
        return Err(LoomCommandError::rejection(
            LOOM_TASK_NOT_READY,
            format!("LOOM task {task_id} is {status} and cannot be claimed"),
        ));
    }
    let blocking = blocking_dependencies(&transaction, &plan_id, &task_id)?;
    if !blocking.is_empty() {
        return Err(LoomCommandError::rejection(
            LOOM_DEPENDENCY_UNRELEASED,
            format!(
                "LOOM task {task_id} is still blocked by {}",
                blocking.join(", ")
            ),
        ));
    }

    let open_claim: Option<(String, String)> = transaction
        .query_row(
            "SELECT claim_id, lease_expires_at FROM loom_claim
             WHERE task_id=?1 AND released_at IS NULL",
            [&task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    // Every claim on the Task, released or not, counts: the fence only ever advances.
    let fence_generation: i64 = transaction.query_row(
        "SELECT COALESCE(MAX(fence_generation),0) FROM loom_claim WHERE task_id=?1",
        [&task_id],
        |row| row.get::<_, i64>(0),
    )? + 1;
    if let Some((held_claim_id, held_lease_expires_at)) = open_claim {
        if !lease_expired(&held_lease_expires_at, now) {
            return Err(LoomCommandError::rejection(
                LOOM_CLAIM_HELD,
                format!("task {task_id} is held by claim {held_claim_id} until {held_lease_expires_at}"),
            ));
        }
        transaction.execute(
            "UPDATE loom_claim SET released_at=?1 WHERE claim_id=?2 AND released_at IS NULL",
            params![&claimed_at, &held_claim_id],
        )?;
    }
    let claim_id = format!("claim_{}", uuid::Uuid::new_v4().simple());
    transaction.execute(
        "INSERT INTO loom_claim(claim_id,plan_id,task_id,agent_run_id,claimant_agent_id,
                              command_id,lease_expires_at,fence_generation,claimed_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![
            &claim_id,
            &plan_id,
            &task_id,
            &agent_run_id,
            claimant_agent_id.as_deref(),
            &command_id,
            &lease_expires_at,
            fence_generation,
            &claimed_at,
        ],
    )?;
    transaction.commit()?;
    Ok(LoomClaimAcquireResult {
        claim_id,
        mission_id,
        plan_id,
        task_id,
        agent_run_id,
        claimant_agent_id,
        fence_generation,
        claimed_at,
        lease_expires_at,
        released_at: None,
        replayed: false,
    })
}

/// What the producing side claims about its own delivery. The persisted literals stay
/// uppercase; the wire shape is the contract's lowercase one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoomVerificationStatus {
    Unverified,
    Verified,
    Failed,
}

impl LoomVerificationStatus {
    fn parse(raw: &str) -> Result<Self> {
        match raw {
            "UNVERIFIED" => Ok(Self::Unverified),
            "VERIFIED" => Ok(Self::Verified),
            "FAILED" => Ok(Self::Failed),
            other => anyhow::bail!("LOOM candidate has an unknown verification status {other}"),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Unverified => "UNVERIFIED",
            Self::Verified => "VERIFIED",
            Self::Failed => "FAILED",
        }
    }
}

/// What the Owner later decided about the delivery. Independent of the verification axis,
/// so a candidate can be VERIFIED and still PENDING acceptance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoomAcceptanceStatus {
    Pending,
    Accepted,
    Rejected,
}

impl LoomAcceptanceStatus {
    fn parse(raw: &str) -> Result<Self> {
        match raw {
            "PENDING" => Ok(Self::Pending),
            "ACCEPTED" => Ok(Self::Accepted),
            "REJECTED" => Ok(Self::Rejected),
            other => anyhow::bail!("LOOM candidate has an unknown acceptance status {other}"),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "PENDING",
            Self::Accepted => "ACCEPTED",
            Self::Rejected => "REJECTED",
        }
    }
}

/// Candidate input: the delivery one Run submits for the Task it still holds. `commandId`
/// is the idempotency key, and `agentRunId` is the fence the Run presents.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoomCandidateRecordInput {
    pub mission_id: String,
    pub task_id: String,
    pub agent_run_id: String,
    pub command_id: String,
    pub content_hash: String,
    #[serde(default)]
    pub evidence_ids: Vec<String>,
    pub acceptance_criteria_version: String,
    #[serde(default)]
    pub previous_candidate_id: Option<String>,
}

/// Candidate receipt: the immutable row a submission created, plus the replay flag.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoomCandidateRecordResult {
    pub candidate_id: String,
    pub mission_id: String,
    pub plan_id: String,
    pub task_id: String,
    pub agent_run_id: String,
    pub content_hash: String,
    pub evidence_ids: Vec<String>,
    pub acceptance_criteria_version: String,
    pub previous_candidate_id: Option<String>,
    pub verification_status: LoomVerificationStatus,
    pub acceptance_status: LoomAcceptanceStatus,
    pub created_at: String,
    /// True when the same `commandId` replayed and no new candidate was written.
    pub replayed: bool,
}

/// One persisted candidate; the row is read back whole because it is never rewritten.
struct StoredCandidate {
    candidate_id: String,
    plan_id: String,
    task_id: String,
    agent_run_id: String,
    content_hash: String,
    evidence_ids_json: String,
    acceptance_criteria_version: String,
    previous_candidate_id: Option<String>,
    verification_status: String,
    acceptance_status: String,
    created_at: String,
}

impl StoredCandidate {
    fn read(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            candidate_id: row.get(0)?,
            plan_id: row.get(1)?,
            task_id: row.get(2)?,
            agent_run_id: row.get(3)?,
            content_hash: row.get(4)?,
            evidence_ids_json: row.get(5)?,
            acceptance_criteria_version: row.get(6)?,
            previous_candidate_id: row.get(7)?,
            verification_status: row.get(8)?,
            acceptance_status: row.get(9)?,
            created_at: row.get(10)?,
        })
    }

    fn into_result(self, mission_id: &str, replayed: bool) -> Result<LoomCandidateRecordResult> {
        // Parse before the owning fields move, so the error context can still name the id.
        let evidence_ids: Vec<String> =
            serde_json::from_str(&self.evidence_ids_json).with_context(|| {
                format!(
                    "candidate {} evidenceIds are not a list of references",
                    self.candidate_id
                )
            })?;
        Ok(LoomCandidateRecordResult {
            candidate_id: self.candidate_id,
            mission_id: mission_id.to_string(),
            plan_id: self.plan_id,
            task_id: self.task_id,
            agent_run_id: self.agent_run_id,
            content_hash: self.content_hash,
            evidence_ids,
            acceptance_criteria_version: self.acceptance_criteria_version,
            previous_candidate_id: self.previous_candidate_id,
            verification_status: LoomVerificationStatus::parse(&self.verification_status)?,
            acceptance_status: LoomAcceptanceStatus::parse(&self.acceptance_status)?,
            created_at: self.created_at,
            replayed,
        })
    }
}

/// The live claim a submitting Run must hold: the fence is the Run identity plus an
/// unexpired lease, never a task state alone.
struct LiveClaim {
    claim_id: String,
    agent_run_id: String,
    lease_expires_at: String,
}

/// LOOM candidate path: a Run submits the delivery for the Task it holds, and the Task
/// moves `READY` → `IN_REVIEW`. The Run must still hold a live claim whose `agentRunId`
/// matches the submission (the submit-side fence), the acceptance criteria version must be
/// the Plan's own, and everything is checked and written in one immediate transaction so a
/// rejected submission leaves neither a candidate nor a moved Task behind.
pub fn candidate_record(
    database: &mut Database,
    input: LoomCandidateRecordInput,
) -> Result<LoomCandidateRecordResult> {
    let mission_id = required_field("candidate record", "missionId", &input.mission_id)?;
    let task_id = required_field("candidate record", "taskId", &input.task_id)?;
    let agent_run_id = required_field("candidate record", "agentRunId", &input.agent_run_id)?;
    let command_id = required_field("candidate record", "commandId", &input.command_id)?;
    let content_hash = required_field("candidate record", "contentHash", &input.content_hash)?;
    let acceptance_criteria_version = required_field(
        "candidate record",
        "acceptanceCriteriaVersion",
        &input.acceptance_criteria_version,
    )?;
    let mut evidence_ids = Vec::with_capacity(input.evidence_ids.len());
    for evidence_id in &input.evidence_ids {
        let evidence_id = evidence_id.trim();
        if evidence_id.is_empty() {
            return Err(LoomCommandError::rejection(
                LOOM_INVALID_INPUT,
                "every candidate evidenceId must be a non-empty reference",
            ));
        }
        evidence_ids.push(evidence_id.to_string());
    }
    let evidence_ids_json = serde_json::to_string(&evidence_ids)?;
    let previous_candidate_id = input
        .previous_candidate_id
        .as_deref()
        .map(str::trim)
        .filter(|candidate_id| !candidate_id.is_empty())
        .map(str::to_string);
    let now = chrono::Utc::now();
    let created_at = now.to_rfc3339();

    let transaction = database
        .connection_mut()
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mission_exists: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM mission WHERE id=?1)",
        [&mission_id],
        |row| row.get(0),
    )?;
    if !mission_exists {
        return Err(LoomCommandError::rejection(
            LOOM_MISSION_NOT_FOUND,
            format!("mission {mission_id} does not exist"),
        ));
    }
    let plan: Option<(String, String)> = transaction
        .query_row(
            "SELECT plan_id, acceptance_criteria_version FROM loom_plan WHERE mission_id=?1",
            [&mission_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((plan_id, plan_criteria_version)) = plan else {
        return Err(LoomCommandError::rejection(
            LOOM_PLAN_NOT_FOUND,
            format!("mission {mission_id} has no LOOM plan"),
        ));
    };
    let status: Option<String> = transaction
        .query_row(
            "SELECT status FROM loom_task WHERE plan_id=?1 AND task_id=?2",
            params![&plan_id, &task_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(status) = status else {
        return Err(LoomCommandError::rejection(
            LOOM_TASK_NOT_FOUND,
            format!("task {task_id} does not belong to the plan of mission {mission_id}"),
        ));
    };

    // A replay returns the candidate the command already recorded; it must not depend on
    // the Task state the first submission moved, and only the same Task and Run may replay.
    let replay: Option<StoredCandidate> = transaction
        .query_row(
            "SELECT candidate_id, plan_id, task_id, agent_run_id, content_hash,
                    evidence_ids_json, acceptance_criteria_version, previous_candidate_id,
                    verification_status, acceptance_status, created_at
             FROM loom_candidate WHERE command_id=?1",
            [&command_id],
            StoredCandidate::read,
        )
        .optional()?;
    if let Some(candidate) = replay {
        if candidate.task_id != task_id || candidate.agent_run_id != agent_run_id {
            return Err(LoomCommandError::rejection(
                LOOM_CANDIDATE_COMMAND_REUSED,
                format!(
                    "commandId {command_id} already recorded candidate {} for task {} held by agentRun {}",
                    candidate.candidate_id, candidate.task_id, candidate.agent_run_id
                ),
            ));
        }
        return candidate.into_result(&mission_id, true);
    }

    // A verdict binds to a frozen snapshot, so the submission must name the Plan's version.
    if plan_criteria_version != acceptance_criteria_version {
        return Err(LoomCommandError::rejection(
            LOOM_ACCEPTANCE_CRITERIA_VERSION_MISMATCH,
            format!(
                "plan {plan_id} is pinned to acceptance criteria version {plan_criteria_version}, not {acceptance_criteria_version}"
            ),
        ));
    }
    if let Some(previous_candidate_id) = &previous_candidate_id {
        let owner: Option<String> = transaction
            .query_row(
                "SELECT task_id FROM loom_candidate WHERE candidate_id=?1",
                [previous_candidate_id],
                |row| row.get(0),
            )
            .optional()?;
        if owner.as_deref() != Some(task_id.as_str()) {
            return Err(LoomCommandError::rejection(
                LOOM_CANDIDATE_PREVIOUS_INVALID,
                format!(
                    "previousCandidateId {previous_candidate_id} is not an earlier candidate of task {task_id}"
                ),
            ));
        }
    }

    // Submit-side fence: the Task must still be held by this very Run on a live lease.
    let claim: Option<LiveClaim> = transaction
        .query_row(
            "SELECT claim_id, agent_run_id, lease_expires_at FROM loom_claim
             WHERE plan_id=?1 AND task_id=?2 AND released_at IS NULL",
            params![&plan_id, &task_id],
            |row| {
                Ok(LiveClaim {
                    claim_id: row.get(0)?,
                    agent_run_id: row.get(1)?,
                    lease_expires_at: row.get(2)?,
                })
            },
        )
        .optional()?;
    let Some(claim) = claim else {
        return Err(LoomCommandError::rejection(
            LOOM_CLAIM_ABSENT,
            format!("task {task_id} carries no unreleased claim to submit under"),
        ));
    };
    if lease_expired(&claim.lease_expires_at, now) {
        return Err(LoomCommandError::rejection(
            LOOM_CLAIM_EXPIRED,
            format!(
                "claim {} on task {task_id} expired at {}",
                claim.claim_id, claim.lease_expires_at
            ),
        ));
    }
    if claim.agent_run_id != agent_run_id {
        return Err(LoomCommandError::rejection(
            LOOM_CLAIM_AGENT_RUN_MISMATCH,
            format!(
                "task {task_id} is held by claim {} for agentRun {}, not {agent_run_id}",
                claim.claim_id, claim.agent_run_id
            ),
        ));
    }
    // Only a READY Task can receive its first delivery; `IN_REVIEW` already has one.
    if status != "READY" {
        return Err(LoomCommandError::rejection(
            LOOM_TASK_NOT_READY,
            format!("LOOM task {task_id} is {status} and cannot submit a candidate"),
        ));
    }

    let candidate_id = format!("candidate_{}", uuid::Uuid::new_v4().simple());
    transaction.execute(
        "INSERT INTO loom_candidate(candidate_id,plan_id,task_id,agent_run_id,command_id,
                                   content_hash,evidence_ids_json,acceptance_criteria_version,
                                   previous_candidate_id,verification_status,acceptance_status,
                                   created_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
        params![
            &candidate_id,
            &plan_id,
            &task_id,
            &agent_run_id,
            &command_id,
            &content_hash,
            &evidence_ids_json,
            &acceptance_criteria_version,
            previous_candidate_id.as_deref(),
            LoomVerificationStatus::Unverified.as_str(),
            LoomAcceptanceStatus::Pending.as_str(),
            &created_at,
        ],
    )?;
    transaction.execute(
        "UPDATE loom_task SET status='IN_REVIEW', updated_at=?1, revision=revision+1
         WHERE plan_id=?2 AND task_id=?3",
        params![&created_at, &plan_id, &task_id],
    )?;
    transaction.commit()?;

    Ok(LoomCandidateRecordResult {
        candidate_id,
        mission_id,
        plan_id,
        task_id,
        agent_run_id,
        content_hash,
        evidence_ids,
        acceptance_criteria_version,
        previous_candidate_id,
        verification_status: LoomVerificationStatus::Unverified,
        acceptance_status: LoomAcceptanceStatus::Pending,
        created_at,
        replayed: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collaboration::ProjectBindingKind;
    use crate::command::{ActorRef, CommandEnvelope};
    use crate::mission::{CreateMissionCommand, MissionService};
    use crate::test_support::OwnedTestDatabase;
    use serde_json::json;

    /// Reuse the existing db_* fixture: a seeded runtime clone plus the Mission owner's
    /// command, so LOOM keeps no second scaffolding of its own.
    fn fixture() -> OwnedTestDatabase {
        crate::test_support::seeded_runtime_database_owned()
    }

    fn command<P>(payload: P) -> CommandEnvelope<P> {
        CommandEnvelope {
            command_id: uuid::Uuid::new_v4().to_string(),
            actor: ActorRef::User {
                user_id: "local_user".into(),
            },
            camp_id: None,
            expected_versions: vec![],
            execution_epoch: None,
            payload,
        }
    }

    /// A real Mission through the product command, because `loom_plan` is keyed by `mission.id`.
    fn create_mission(database: &mut OwnedTestDatabase, title: &str) -> String {
        let workspace = database
            .directory()
            .join(format!("loom-workspace-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&workspace).unwrap();
        let created = MissionService::default()
            .create(
                database,
                &command(CreateMissionCommand {
                    team: None,
                    title: title.into(),
                    description: String::new(),
                    description_content: None,
                    project_path: workspace.to_string_lossy().into_owned(),
                    project_binding_kind: ProjectBindingKind::Directory,
                    member_agent_ids: vec!["agent_1".into()],
                    default_lead_agent_id: "agent_1".into(),
                    tags: vec![],
                    source_attachments: vec![],
                }),
            )
            .unwrap();
        created.result.payload["missionId"]
            .as_str()
            .expect("mission creation must return a missionId")
            .to_string()
    }

    fn criterion(criterion_id: &str, text: &str) -> LoomPlanImportCriterion {
        LoomPlanImportCriterion {
            criterion_id: criterion_id.into(),
            text: text.into(),
        }
    }

    fn task(task_id: &str, title: &str) -> LoomPlanImportTask {
        LoomPlanImportTask {
            task_id: task_id.into(),
            title: title.into(),
            description: String::new(),
            assignee_agent_id: None,
        }
    }

    fn edge(upstream_task_id: &str, downstream_task_id: &str) -> LoomPlanImportDependency {
        LoomPlanImportDependency {
            upstream_task_id: upstream_task_id.into(),
            downstream_task_id: downstream_task_id.into(),
            condition: None,
        }
    }

    fn plan_input(mission_id: &str) -> LoomPlanImportInput {
        LoomPlanImportInput {
            mission_id: mission_id.into(),
            goal: "Ship the LOOM plan".into(),
            acceptance_criteria_version: "ac-v1".into(),
            criteria: vec![
                criterion("criterion_one", "one"),
                criterion("criterion_two", "two"),
            ],
            tasks: vec![task("task_a", "Task A"), task("task_b", "Task B")],
            dependencies: vec![edge("task_a", "task_b")],
        }
    }

    fn rejection_code(error: &anyhow::Error) -> &'static str {
        error
            .downcast_ref::<LoomPlanImportError>()
            .unwrap_or_else(|| panic!("expected a LOOM plan import rejection, got: {error}"))
            .code()
    }

    /// (plan, task, dependency) row counts of the three LOOM tables.
    fn loom_rows(database: &Database) -> (i64, i64, i64) {
        let count = |table: &str| -> i64 {
            database
                .connection()
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap()
        };
        (
            count("loom_plan"),
            count("loom_task"),
            count("loom_dependency"),
        )
    }

    #[test]
    fn import_reads_back_lowercase_status_criteria_snapshot_and_null_resolution() {
        let mut database = fixture();
        let mission_id = create_mission(&mut database, "LOOM read back");

        let imported = plan_import(&mut database, plan_input(&mission_id)).unwrap();
        assert_eq!(
            imported.mission_id, mission_id,
            "assertion import_result_echoes_mission_id"
        );
        assert_eq!(
            imported.task_ids,
            vec!["task_a".to_string(), "task_b".to_string()],
            "assertion import_result_echoes_task_ids_in_submission_order"
        );
        assert_eq!(
            imported.acceptance_criteria_version, "ac-v1",
            "assertion import_result_echoes_criteria_version"
        );
        assert_eq!(
            imported.dependency_ids.len(),
            1,
            "assertion import_result_echoes_one_dependency_id"
        );

        let plan = plan_get(&database, &mission_id)
            .unwrap()
            .expect("plan_get must read back the imported plan");
        assert_eq!(
            plan.plan_id, imported.plan_id,
            "assertion plan_get_returns_the_imported_plan_id"
        );
        assert_eq!(
            plan.goal, "Ship the LOOM plan",
            "assertion plan_get_returns_the_imported_goal"
        );
        assert_eq!(
            plan.revision, 1,
            "assertion imported_plan_starts_at_revision_one"
        );
        assert_eq!(
            plan.acceptance_criteria.version, "ac-v1",
            "assertion plan_snapshot_carries_the_imported_version"
        );
        assert_eq!(
            plan.acceptance_criteria.criteria,
            vec![
                LoomAcceptanceCriterion {
                    criterion_id: "criterion_one".into(),
                    text: "one".into(),
                },
                LoomAcceptanceCriterion {
                    criterion_id: "criterion_two".into(),
                    text: "two".into(),
                },
            ],
            "assertion plan_snapshot_carries_the_imported_criteria_rows"
        );
        let plan_wire = serde_json::to_value(&plan).unwrap();
        assert_eq!(
            plan_wire["acceptanceCriteria"]["version"],
            json!("ac-v1"),
            "assertion plan_wire_snapshot_is_version_and_criteria"
        );
        assert_eq!(
            plan_wire["acceptanceCriteria"]["criteria"][0]["criterionId"],
            json!("criterion_one"),
            "assertion plan_wire_criteria_rows_are_criterion_id_facts"
        );

        let tasks = tasks_list(&database, &mission_id).unwrap();
        assert_eq!(
            tasks.len(),
            2,
            "assertion tasks_list_returns_every_imported_task"
        );
        assert_eq!(
            tasks
                .iter()
                .map(|task| task.task_id.as_str())
                .collect::<Vec<_>>(),
            vec!["task_a", "task_b"],
            "assertion tasks_list_is_plan_scoped_and_ordered"
        );
        for task in &tasks {
            assert_eq!(
                task.plan_id, imported.plan_id,
                "assertion task_belongs_to_the_imported_plan"
            );
            assert_eq!(
                task.status,
                LoomTaskStatus::Draft,
                "assertion imported_task_starts_draft"
            );
            assert_eq!(
                task.revision, 1,
                "assertion imported_task_starts_at_revision_one"
            );
            assert_eq!(
                task.blocked_reason, None,
                "assertion imported_draft_task_has_no_blocked_reason"
            );
            assert_eq!(
                task.acceptance_criteria, plan.acceptance_criteria,
                "assertion every_task_inherits_the_plan_criteria_snapshot"
            );
            let task_wire = serde_json::to_value(task).unwrap();
            assert_eq!(
                task_wire["status"],
                json!("draft"),
                "assertion task_status_wire_shape_is_lowercase"
            );
            assert_eq!(
                task_wire["acceptanceCriteria"],
                json!({
                    "version": "ac-v1",
                    "criteria": [
                        {"criterionId": "criterion_one", "text": "one"},
                        {"criterionId": "criterion_two", "text": "two"},
                    ],
                }),
                "assertion task_acceptance_criteria_wire_shape_is_version_and_criteria"
            );
        }

        let dependencies = dependencies_list(&database, &mission_id).unwrap();
        assert_eq!(
            dependencies.len(),
            1,
            "assertion dependencies_list_returns_the_imported_edge"
        );
        let dependency = &dependencies[0];
        assert_eq!(
            dependency.dependency_id, imported.dependency_ids[0],
            "assertion dependency_id_matches_the_import_receipt"
        );
        assert_eq!(
            dependency.upstream_task_id, "task_a",
            "assertion dependency_keeps_the_imported_upstream_task"
        );
        assert_eq!(
            dependency.downstream_task_id, "task_b",
            "assertion dependency_keeps_the_imported_downstream_task"
        );
        assert_eq!(
            dependency.condition,
            LoomDependencyCondition::TaskDone,
            "assertion omitted_condition_defaults_to_task_done"
        );
        assert_eq!(
            dependency.resolved_artifact_id, None,
            "assertion fresh_dependency_has_no_resolved_artifact"
        );
        assert_eq!(
            dependency.resolution, None,
            "assertion fresh_dependency_resolution_is_absent"
        );
        let dependency_wire = serde_json::to_value(dependency).unwrap();
        assert_eq!(
            dependency_wire["condition"],
            json!("task_done"),
            "assertion dependency_condition_wire_shape_is_lowercase"
        );
        assert_eq!(
            dependency_wire["resolution"],
            serde_json::Value::Null,
            "assertion dependency_resolution_wire_shape_is_null"
        );
    }

    #[test]
    fn import_rejects_unknown_mission_without_writing_loom_rows() {
        let mut database = fixture();
        let missing_mission = "rvm_loom_missing_mission";

        let error = plan_import(&mut database, plan_input(missing_mission)).unwrap_err();
        assert_eq!(
            rejection_code(&error),
            LOOM_MISSION_NOT_FOUND,
            "assertion unknown_mission_is_rejected"
        );
        assert!(
            plan_get(&database, missing_mission).unwrap().is_none(),
            "assertion rejected_mission_gains_no_readable_plan"
        );
        assert_eq!(
            loom_rows(&database),
            (0, 0, 0),
            "assertion unknown_mission_import_writes_no_loom_rows"
        );
    }

    #[test]
    fn second_import_for_the_same_mission_is_rejected_as_plan_exists() {
        let mut database = fixture();
        let mission_id = create_mission(&mut database, "LOOM one plan per mission");
        let first = plan_import(&mut database, plan_input(&mission_id)).unwrap();

        let mut second = plan_input(&mission_id);
        second.goal = "A second plan".into();
        second.tasks = vec![task("task_c", "Task C")];
        second.dependencies = vec![];
        let error = plan_import(&mut database, second).unwrap_err();
        assert_eq!(
            rejection_code(&error),
            LOOM_PLAN_EXISTS,
            "assertion second_plan_for_the_same_mission_is_rejected"
        );
        assert_eq!(
            plan_get(&database, &mission_id).unwrap().unwrap().plan_id,
            first.plan_id,
            "assertion rejected_second_import_keeps_the_first_plan"
        );
        assert_eq!(
            loom_rows(&database),
            (1, 2, 1),
            "assertion rejected_second_import_writes_no_loom_rows"
        );
    }

    #[test]
    fn duplicate_task_id_inside_one_batch_is_rejected() {
        let mut database = fixture();
        let mission_id = create_mission(&mut database, "LOOM duplicate task");

        let mut input = plan_input(&mission_id);
        input.tasks = vec![task("task_a", "Task A"), task("task_a", "Task A again")];
        input.dependencies = vec![];
        let error = plan_import(&mut database, input).unwrap_err();
        assert_eq!(
            rejection_code(&error),
            LOOM_TASK_DUPLICATE,
            "assertion duplicate_task_id_in_one_batch_is_rejected"
        );
        assert_eq!(
            loom_rows(&database),
            (0, 0, 0),
            "assertion duplicate_task_id_writes_no_loom_rows"
        );
    }

    #[test]
    fn duplicate_criterion_id_is_rejected() {
        let mut database = fixture();
        let mission_id = create_mission(&mut database, "LOOM duplicate criterion");

        let mut input = plan_input(&mission_id);
        input.criteria = vec![
            criterion("criterion_one", "one"),
            criterion("criterion_one", "one again"),
        ];
        let error = plan_import(&mut database, input).unwrap_err();
        assert_eq!(
            rejection_code(&error),
            LOOM_CRITERION_DUPLICATE,
            "assertion duplicate_criterion_id_is_rejected"
        );
        assert_eq!(
            loom_rows(&database),
            (0, 0, 0),
            "assertion duplicate_criterion_id_writes_no_loom_rows"
        );
    }

    #[test]
    fn dependency_on_a_task_outside_the_plan_is_rejected() {
        let mut database = fixture();
        let mission_id = create_mission(&mut database, "LOOM dangling dependency");

        let mut input = plan_input(&mission_id);
        input.dependencies = vec![edge("task_a", "task_missing")];
        let error = plan_import(&mut database, input).unwrap_err();
        assert_eq!(
            rejection_code(&error),
            LOOM_DEPENDENCY_TASK_MISSING,
            "assertion dependency_outside_the_imported_plan_is_rejected"
        );
        assert_eq!(
            loom_rows(&database),
            (0, 0, 0),
            "assertion dangling_dependency_writes_no_loom_rows"
        );
    }

    #[test]
    fn self_dependency_is_rejected() {
        let mut database = fixture();
        let mission_id = create_mission(&mut database, "LOOM self dependency");

        let mut input = plan_input(&mission_id);
        input.dependencies = vec![edge("task_a", "task_a")];
        let error = plan_import(&mut database, input).unwrap_err();
        assert_eq!(
            rejection_code(&error),
            LOOM_DEPENDENCY_SELF,
            "assertion task_cannot_depend_on_itself"
        );
        assert_eq!(
            loom_rows(&database),
            (0, 0, 0),
            "assertion self_dependency_writes_no_loom_rows"
        );
    }

    #[test]
    fn task_ids_containing_the_edge_separator_do_not_collide() {
        // Task IDs are opaque: a -> b->c and a->b -> c are both legal acyclic graphs.
        // Composing an edge ID from endpoint names made both produce "a->b->c".
        let mut database = fixture();
        let mission_id = create_mission(&mut database, "LOOM separator task ids");
        let mut input = plan_input(&mission_id);
        input.tasks = vec![
            task("a", "Task A"),
            task("b->c", "Task B to C"),
            task("a->b", "Task A to B"),
            task("c", "Task C"),
        ];
        input.dependencies = vec![edge("a", "b->c"), edge("a->b", "c")];
        let receipt = plan_import(&mut database, input).expect("assertion legal graph imports");
        assert_eq!(
            receipt.dependency_ids.len(),
            2,
            "assertion both separator-shaped edges are recorded"
        );
        assert_ne!(
            receipt.dependency_ids[0], receipt.dependency_ids[1],
            "assertion separator-shaped edges keep distinct dependency ids"
        );
        let edges = dependencies_list(&database, &mission_id).expect("assertion edges read back");
        assert_eq!(edges.len(), 2, "assertion both edges persist");
        assert_eq!(
            loom_rows(&database),
            (1, 4, 2),
            "assertion separator-shaped plan writes one full graph"
        );
    }

    #[test]
    fn dependency_cycle_is_rejected() {
        let mut database = fixture();
        let mission_id = create_mission(&mut database, "LOOM dependency cycle");

        let mut input = plan_input(&mission_id);
        input.tasks = vec![
            task("task_a", "Task A"),
            task("task_b", "Task B"),
            task("task_c", "Task C"),
        ];
        input.dependencies = vec![
            edge("task_a", "task_b"),
            edge("task_b", "task_c"),
            edge("task_c", "task_a"),
        ];
        let error = plan_import(&mut database, input).unwrap_err();
        assert_eq!(
            rejection_code(&error),
            LOOM_DAG_CYCLE,
            "assertion a_to_b_to_c_to_a_cycle_is_rejected"
        );
        assert!(
            error.to_string().contains("task_a -> task_b -> task_c -> task_a"),
            "assertion cycle_rejection_names_the_task_path: {error}"
        );
        assert!(
            plan_get(&database, &mission_id).unwrap().is_none(),
            "assertion cyclic_plan_gains_no_readable_plan"
        );
        assert_eq!(
            loom_rows(&database),
            (0, 0, 0),
            "assertion cyclic_plan_writes_no_loom_rows"
        );
    }

    #[test]
    fn rejected_import_rolls_back_every_loom_table() {
        let mut database = fixture();
        let mission_id = create_mission(&mut database, "LOOM rollback");

        // Fault inside the write transaction, after the plan row, so only the rollback
        // of the three inserts can keep the projection empty.
        database
            .connection()
            .execute_batch(
                "CREATE TEMP TRIGGER reject_loom_task_insert BEFORE INSERT ON loom_task
                 BEGIN SELECT RAISE(ABORT,'loom task insert rejected'); END;",
            )
            .unwrap();
        let error = plan_import(&mut database, plan_input(&mission_id)).unwrap_err();
        database
            .connection()
            .execute_batch("DROP TRIGGER reject_loom_task_insert;")
            .unwrap();
        assert!(
            error.to_string().contains("loom task insert rejected"),
            "assertion mid_transaction_fault_surfaces_as_an_error: {error}"
        );
        assert_eq!(
            loom_rows(&database),
            (0, 0, 0),
            "assertion failed_transaction_leaves_no_plan_task_or_dependency_rows"
        );
        assert!(
            plan_get(&database, &mission_id).unwrap().is_none(),
            "assertion failed_transaction_leaves_no_readable_plan"
        );

        // The rejection does not poison the connection: the same input now commits whole.
        let imported = plan_import(&mut database, plan_input(&mission_id)).unwrap();
        assert_eq!(
            loom_rows(&database),
            (1, 2, 1),
            "assertion clean_retry_commits_the_whole_graph"
        );
        assert_eq!(
            plan_get(&database, &mission_id).unwrap().unwrap().plan_id,
            imported.plan_id,
            "assertion clean_retry_plan_is_the_readable_one"
        );
    }

    #[test]
    fn plans_are_isolated_per_mission() {
        let mut database = fixture();
        let first_mission = create_mission(&mut database, "LOOM isolation one");
        let second_mission = create_mission(&mut database, "LOOM isolation two");
        let unplanned_mission = create_mission(&mut database, "LOOM isolation unplanned");

        let first = plan_import(&mut database, plan_input(&first_mission)).unwrap();

        let mut second_input = plan_input(&second_mission);
        second_input.goal = "Ship the other LOOM plan".into();
        second_input.acceptance_criteria_version = "ac-v2".into();
        second_input.criteria = vec![criterion("criterion_other", "other")];
        second_input.tasks = vec![task("task_c", "Task C"), task("task_d", "Task D")];
        second_input.dependencies = vec![edge("task_c", "task_d")];
        let second = plan_import(&mut database, second_input).unwrap();

        let first_plan = plan_get(&database, &first_mission).unwrap().unwrap();
        assert_eq!(
            first_plan.plan_id, first.plan_id,
            "assertion first_mission_reads_only_its_own_plan"
        );
        assert_eq!(
            first_plan.goal, "Ship the LOOM plan",
            "assertion first_mission_keeps_its_own_goal"
        );
        assert_eq!(
            first_plan.acceptance_criteria.version, "ac-v1",
            "assertion criteria_versions_do_not_leak_across_missions"
        );
        assert_eq!(
            first_plan.acceptance_criteria.criteria.len(),
            2,
            "assertion first_mission_keeps_its_own_criteria_rows"
        );

        let second_plan = plan_get(&database, &second_mission).unwrap().unwrap();
        assert_eq!(
            second_plan.plan_id, second.plan_id,
            "assertion second_mission_reads_only_its_own_plan"
        );
        assert_eq!(
            second_plan.goal, "Ship the other LOOM plan",
            "assertion second_mission_keeps_its_own_goal"
        );
        assert_eq!(
            second_plan.acceptance_criteria.criteria,
            vec![LoomAcceptanceCriterion {
                criterion_id: "criterion_other".into(),
                text: "other".into(),
            }],
            "assertion second_mission_keeps_its_own_criteria_rows"
        );
        assert!(
            plan_get(&database, &unplanned_mission).unwrap().is_none(),
            "assertion unplanned_mission_reads_no_plan"
        );

        let task_ids = |mission_id: &str| {
            tasks_list(&database, mission_id)
                .unwrap()
                .into_iter()
                .map(|task| task.task_id)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            task_ids(&first_mission),
            vec!["task_a".to_string(), "task_b".to_string()],
            "assertion first_mission_sees_only_its_own_tasks"
        );
        assert_eq!(
            task_ids(&second_mission),
            vec!["task_c".to_string(), "task_d".to_string()],
            "assertion second_mission_sees_only_its_own_tasks"
        );
        assert_eq!(
            task_ids(&unplanned_mission),
            Vec::<String>::new(),
            "assertion unplanned_mission_sees_no_tasks"
        );

        let edges = |mission_id: &str| {
            dependencies_list(&database, mission_id)
                .unwrap()
                .into_iter()
                .map(|dependency| (dependency.upstream_task_id, dependency.downstream_task_id))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            edges(&first_mission),
            vec![("task_a".to_string(), "task_b".to_string())],
            "assertion first_mission_sees_only_its_own_edge"
        );
        assert_eq!(
            edges(&second_mission),
            vec![("task_c".to_string(), "task_d".to_string())],
            "assertion second_mission_sees_only_its_own_edge"
        );
        assert_eq!(
            edges(&unplanned_mission),
            Vec::<(String, String)>::new(),
            "assertion unplanned_mission_sees_no_edges"
        );
        assert_eq!(
            loom_rows(&database),
            (2, 4, 2),
            "assertion two_missions_hold_two_independent_graphs"
        );
    }

    fn release_input(mission_id: &str, task_id: &str) -> LoomTaskReleaseInput {
        LoomTaskReleaseInput {
            mission_id: mission_id.into(),
            task_id: task_id.into(),
        }
    }

    fn claim_input(
        mission_id: &str,
        task_id: &str,
        agent_run_id: &str,
        command_id: &str,
    ) -> LoomClaimAcquireInput {
        LoomClaimAcquireInput {
            mission_id: mission_id.into(),
            task_id: task_id.into(),
            agent_run_id: agent_run_id.into(),
            claimant_agent_id: Some("agent_1".into()),
            command_id: command_id.into(),
            lease_seconds: None,
        }
    }

    fn command_code(error: &anyhow::Error) -> &'static str {
        error
            .downcast_ref::<LoomCommandError>()
            .unwrap_or_else(|| panic!("expected a LOOM command rejection, got: {error}"))
            .code()
    }

    fn claim_rows(database: &Database) -> i64 {
        database
            .connection()
            .query_row("SELECT COUNT(*) FROM loom_claim", [], |row| row.get(0))
            .unwrap()
    }

    fn open_claims(database: &Database, task_id: &str) -> i64 {
        database
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM loom_claim WHERE task_id=?1 AND released_at IS NULL",
                [task_id],
                |row| row.get(0),
            )
            .unwrap()
    }

    fn task_status(database: &Database, task_id: &str) -> String {
        database
            .connection()
            .query_row("SELECT status FROM loom_task WHERE task_id=?1", [task_id], |row| {
                row.get(0)
            })
            .unwrap()
    }

    /// Age an open lease so the takeover rule, not the wall clock, decides.
    fn expire_lease(database: &Database, claim_id: &str) {
        database
            .connection()
            .execute(
                "UPDATE loom_claim SET lease_expires_at='2000-01-01T00:00:00+00:00' WHERE claim_id=?1",
                [claim_id],
            )
            .unwrap();
    }

    #[test]
    fn release_moves_a_draft_task_to_ready_and_a_second_release_is_rejected() {
        let mut database = fixture();
        let mission_id = create_mission(&mut database, "LOOM release");
        plan_import(&mut database, plan_input(&mission_id)).unwrap();
        assert_eq!(
            task_status(&database, "task_a"),
            "DRAFT",
            "assertion imported_task_starts_as_draft"
        );

        let released = task_release(&mut database, release_input(&mission_id, "task_a")).unwrap();
        assert_eq!(
            released.mission_id, mission_id,
            "assertion release_result_echoes_mission_id"
        );
        assert_eq!(
            released.task.task_id, "task_a",
            "assertion release_result_names_the_released_task"
        );
        assert_eq!(
            released.task.status,
            LoomTaskStatus::Ready,
            "assertion released_task_reads_back_ready"
        );
        assert_eq!(
            released.task.revision, 2,
            "assertion release_bumps_the_task_revision"
        );
        assert_eq!(
            task_status(&database, "task_b"),
            "DRAFT",
            "assertion release_leaves_the_other_task_alone"
        );

        let error = task_release(&mut database, release_input(&mission_id, "task_a")).unwrap_err();
        assert_eq!(
            command_code(&error),
            LOOM_TASK_NOT_DRAFT,
            "assertion second_release_of_the_same_task_is_rejected"
        );
        assert_eq!(
            task_status(&database, "task_a"),
            "READY",
            "assertion rejected_release_keeps_the_task_ready"
        );
    }

    #[test]
    fn release_rejects_a_task_outside_the_mission_plan() {
        let mut database = fixture();
        let first_mission = create_mission(&mut database, "LOOM release owner");
        let second_mission = create_mission(&mut database, "LOOM release stranger");
        plan_import(&mut database, plan_input(&first_mission)).unwrap();
        let mut stranger_plan = plan_input(&second_mission);
        stranger_plan.tasks = vec![task("task_c", "Task C")];
        stranger_plan.dependencies = vec![];
        plan_import(&mut database, stranger_plan).unwrap();

        let error =
            task_release(&mut database, release_input(&second_mission, "task_a")).unwrap_err();
        assert_eq!(
            command_code(&error),
            LOOM_TASK_NOT_FOUND,
            "assertion release_rejects_a_task_of_another_missions_plan"
        );
        assert_eq!(
            task_status(&database, "task_a"),
            "DRAFT",
            "assertion foreign_mission_release_changes_nothing"
        );

        let unplanned = create_mission(&mut database, "LOOM release unplanned");
        let error = task_release(&mut database, release_input(&unplanned, "task_a")).unwrap_err();
        assert_eq!(
            command_code(&error),
            LOOM_PLAN_NOT_FOUND,
            "assertion release_rejects_a_mission_without_a_plan"
        );
        let error = task_release(&mut database, release_input("mission_missing", "task_a"))
            .unwrap_err();
        assert_eq!(
            command_code(&error),
            LOOM_MISSION_NOT_FOUND,
            "assertion release_rejects_an_unknown_mission"
        );
    }

    #[test]
    fn second_acquire_of_a_ready_task_is_rejected_as_claim_held() {
        let mut database = fixture();
        let mission_id = create_mission(&mut database, "LOOM claim held");
        let plan_id = plan_import(&mut database, plan_input(&mission_id))
            .unwrap()
            .plan_id;
        task_release(&mut database, release_input(&mission_id, "task_a")).unwrap();

        let first = claim_acquire(
            &mut database,
            claim_input(&mission_id, "task_a", "run_one", "command_one"),
        )
        .unwrap();
        assert_eq!(
            first.fence_generation, 1,
            "assertion first_claim_starts_at_fence_one"
        );
        assert_eq!(
            task_status(&database, "task_a"),
            "READY",
            "assertion acquire_keeps_the_task_ready"
        );

        let error = claim_acquire(
            &mut database,
            claim_input(&mission_id, "task_a", "run_two", "command_two"),
        )
        .unwrap_err();
        assert_eq!(
            command_code(&error),
            LOOM_CLAIM_HELD,
            "assertion second_run_cannot_hold_a_leased_task"
        );
        assert_eq!(
            claim_rows(&database),
            1,
            "assertion rejected_acquire_writes_no_claim"
        );

        // The uniqueness is a database guard, not only the Rust pre-check: a direct write
        // of a second open claim has to be refused by the partial unique index.
        let raw = database.connection().execute(
            "INSERT INTO loom_claim(claim_id,plan_id,task_id,agent_run_id,claimant_agent_id,
                                   command_id,lease_expires_at,fence_generation,claimed_at)
             VALUES('claim_direct',?1,'task_a','run_three','agent_1','command_three',
                    '2999-01-01T00:00:00+00:00',2,'2999-01-01T00:00:00+00:00')",
            [&plan_id],
        );
        assert!(
            raw.is_err(),
            "assertion open_lease_is_enforced_by_a_partial_unique_index"
        );
        assert_eq!(
            claim_rows(&database),
            1,
            "assertion rejected_direct_insert_writes_no_claim"
        );
        assert_eq!(
            open_claims(&database, "task_a"),
            1,
            "assertion exactly_one_run_holds_the_task"
        );
    }

    #[test]
    fn replayed_command_id_returns_the_original_claim() {
        let mut database = fixture();
        let mission_id = create_mission(&mut database, "LOOM claim replay");
        plan_import(&mut database, plan_input(&mission_id)).unwrap();
        task_release(&mut database, release_input(&mission_id, "task_a")).unwrap();
        task_release(&mut database, release_input(&mission_id, "task_b")).unwrap();

        let first = claim_acquire(
            &mut database,
            claim_input(&mission_id, "task_a", "run_one", "command_one"),
        )
        .unwrap();
        let replay = claim_acquire(
            &mut database,
            claim_input(&mission_id, "task_a", "run_one", "command_one"),
        )
        .unwrap();
        assert_eq!(
            replay.claim_id, first.claim_id,
            "assertion replay_returns_the_original_claim_id"
        );
        assert!(
            replay.replayed,
            "assertion replay_reports_that_it_replayed"
        );
        assert_eq!(
            replay.fence_generation, first.fence_generation,
            "assertion replay_does_not_advance_the_fence"
        );
        assert_eq!(
            claim_rows(&database),
            1,
            "assertion replay_writes_no_second_claim"
        );

        let reused = claim_acquire(
            &mut database,
            claim_input(&mission_id, "task_b", "run_one", "command_one"),
        )
        .unwrap_err();
        assert_eq!(
            command_code(&reused),
            LOOM_CLAIM_COMMAND_REUSED,
            "assertion a_command_id_cannot_be_reused_for_another_task"
        );
        assert_eq!(
            claim_rows(&database),
            1,
            "assertion reused_command_writes_no_claim"
        );
    }

    #[test]
    fn expired_lease_is_taken_over_with_a_higher_fence() {
        let mut database = fixture();
        let mission_id = create_mission(&mut database, "LOOM claim takeover");
        plan_import(&mut database, plan_input(&mission_id)).unwrap();
        task_release(&mut database, release_input(&mission_id, "task_a")).unwrap();

        let first = claim_acquire(
            &mut database,
            claim_input(&mission_id, "task_a", "run_one", "command_one"),
        )
        .unwrap();
        expire_lease(&database, &first.claim_id);

        let takeover = claim_acquire(
            &mut database,
            claim_input(&mission_id, "task_a", "run_two", "command_two"),
        )
        .unwrap();
        assert_eq!(
            takeover.fence_generation, 2,
            "assertion takeover_advances_the_fence"
        );
        assert_ne!(
            takeover.claim_id, first.claim_id,
            "assertion takeover_binds_a_new_claim_row"
        );
        assert_eq!(
            takeover.agent_run_id, "run_two",
            "assertion takeover_binds_the_new_run"
        );
        let released: Option<String> = database
            .connection()
            .query_row(
                "SELECT released_at FROM loom_claim WHERE claim_id=?1",
                [&first.claim_id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            released.is_some(),
            "assertion takeover_releases_the_expired_claim"
        );
        assert_eq!(
            open_claims(&database, "task_a"),
            1,
            "assertion takeover_leaves_one_open_claim"
        );
        assert_eq!(
            claim_rows(&database),
            2,
            "assertion takeover_keeps_the_released_claim_as_history"
        );
        assert_eq!(
            task_status(&database, "task_a"),
            "READY",
            "assertion takeover_keeps_the_task_ready"
        );
    }

    #[test]
    fn acquire_rejects_a_task_whose_dependency_is_unreleased() {
        let mut database = fixture();
        let mission_id = create_mission(&mut database, "LOOM claim dependency");
        plan_import(&mut database, plan_input(&mission_id)).unwrap();
        task_release(&mut database, release_input(&mission_id, "task_a")).unwrap();
        task_release(&mut database, release_input(&mission_id, "task_b")).unwrap();

        let error = claim_acquire(
            &mut database,
            claim_input(&mission_id, "task_b", "run_one", "command_one"),
        )
        .unwrap_err();
        assert_eq!(
            command_code(&error),
            LOOM_DEPENDENCY_UNRELEASED,
            "assertion downstream_task_cannot_be_claimed_before_its_edge_releases"
        );
        assert_eq!(
            claim_rows(&database),
            0,
            "assertion blocked_acquire_writes_no_claim"
        );

        // The release rule reads the upstream Task state, not a caller assertion.
        database
            .connection()
            .execute("UPDATE loom_task SET status='DONE' WHERE task_id='task_a'", [])
            .unwrap();
        let acquired = claim_acquire(
            &mut database,
            claim_input(&mission_id, "task_b", "run_one", "command_one"),
        )
        .unwrap();
        assert_eq!(
            acquired.task_id, "task_b",
            "assertion released_edge_admits_the_downstream_claim"
        );
        assert_eq!(
            claim_rows(&database),
            1,
            "assertion released_edge_writes_exactly_one_claim"
        );
    }

    #[test]
    fn acquire_rejects_a_task_that_was_never_released() {
        let mut database = fixture();
        let mission_id = create_mission(&mut database, "LOOM claim not ready");
        plan_import(&mut database, plan_input(&mission_id)).unwrap();

        let error = claim_acquire(
            &mut database,
            claim_input(&mission_id, "task_a", "run_one", "command_one"),
        )
        .unwrap_err();
        assert_eq!(
            command_code(&error),
            LOOM_TASK_NOT_READY,
            "assertion draft_task_cannot_be_claimed"
        );
        let error = claim_acquire(
            &mut database,
            claim_input(&mission_id, "task_missing", "run_one", "command_one"),
        )
        .unwrap_err();
        assert_eq!(
            command_code(&error),
            LOOM_TASK_NOT_FOUND,
            "assertion unknown_task_cannot_be_claimed"
        );
        let error = claim_acquire(
            &mut database,
            claim_input("mission_missing", "task_a", "run_one", "command_one"),
        )
        .unwrap_err();
        assert_eq!(
            command_code(&error),
            LOOM_MISSION_NOT_FOUND,
            "assertion unknown_mission_cannot_be_claimed"
        );
        assert_eq!(
            claim_rows(&database),
            0,
            "assertion rejected_acquires_write_no_claims"
        );
        assert_eq!(
            task_status(&database, "task_a"),
            "DRAFT",
            "assertion rejected_acquires_leave_the_task_state_alone"
        );
    }

    #[test]
    fn failed_claim_insert_rolls_back_the_whole_takeover() {
        let mut database = fixture();
        let mission_id = create_mission(&mut database, "LOOM claim rollback");
        plan_import(&mut database, plan_input(&mission_id)).unwrap();
        task_release(&mut database, release_input(&mission_id, "task_a")).unwrap();

        let first = claim_acquire(
            &mut database,
            claim_input(&mission_id, "task_a", "run_one", "command_one"),
        )
        .unwrap();
        expire_lease(&database, &first.claim_id);
        database
            .connection()
            .execute_batch(
                "CREATE TEMP TRIGGER reject_claim_insert BEFORE INSERT ON loom_claim
                 BEGIN SELECT RAISE(ABORT, 'loom claim insert rejected'); END;",
            )
            .unwrap();

        let error = claim_acquire(
            &mut database,
            claim_input(&mission_id, "task_a", "run_two", "command_two"),
        )
        .unwrap_err();
        assert!(
            format!("{error:#}").contains("loom claim insert rejected"),
            "unexpected claim failure: {error:#}"
        );
        database
            .connection()
            .execute_batch("DROP TRIGGER reject_claim_insert")
            .unwrap();

        let released: Option<String> = database
            .connection()
            .query_row(
                "SELECT released_at FROM loom_claim WHERE claim_id=?1",
                [&first.claim_id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            released.is_none(),
            "assertion failed_insert_does_not_release_the_expired_claim"
        );
        assert_eq!(
            claim_rows(&database),
            1,
            "assertion failed_insert_leaves_no_orphan_claim"
        );
        assert_eq!(
            open_claims(&database, "task_a"),
            1,
            "assertion failed_insert_keeps_the_single_open_claim"
        );

        // The same command then commits as one unit once the fault is gone.
        let retried = claim_acquire(
            &mut database,
            claim_input(&mission_id, "task_a", "run_two", "command_two"),
        )
        .unwrap();
        assert_eq!(
            retried.fence_generation, 2,
            "assertion retry_after_the_rolled_back_failure_advances_the_fence"
        );
        assert_eq!(
            claim_rows(&database),
            2,
            "assertion retry_writes_the_takeover_claim"
        );
    }

    fn candidate_input(
        mission_id: &str,
        task_id: &str,
        agent_run_id: &str,
        command_id: &str,
    ) -> LoomCandidateRecordInput {
        LoomCandidateRecordInput {
            mission_id: mission_id.into(),
            task_id: task_id.into(),
            agent_run_id: agent_run_id.into(),
            command_id: command_id.into(),
            content_hash: "sha256:candidate".into(),
            evidence_ids: vec!["evidence_one".into(), "evidence_two".into()],
            acceptance_criteria_version: "ac-v1".into(),
            previous_candidate_id: None,
        }
    }

    fn candidate_rows(database: &Database) -> i64 {
        database
            .connection()
            .query_row("SELECT COUNT(*) FROM loom_candidate", [], |row| {
                row.get(0)
            })
            .unwrap()
    }

    fn task_revision(database: &Database, task_id: &str) -> i64 {
        database
            .connection()
            .query_row(
                "SELECT revision FROM loom_task WHERE task_id=?1",
                [task_id],
                |row| row.get(0),
            )
            .unwrap()
    }

    /// A released, claimed task: the only state a delivery may be submitted from.
    fn held_task(
        database: &mut OwnedTestDatabase,
        mission_id: &str,
        task_id: &str,
        agent_run_id: &str,
        command_id: &str,
    ) -> LoomClaimAcquireResult {
        plan_import(database, plan_input(mission_id)).unwrap();
        task_release(database, release_input(mission_id, task_id)).unwrap();
        claim_acquire(
            database,
            claim_input(mission_id, task_id, agent_run_id, command_id),
        )
        .unwrap()
    }

    #[test]
    fn candidate_record_submits_a_held_task_and_advances_it_to_in_review() {
        let mut database = fixture();
        let mission_id = create_mission(&mut database, "LOOM candidate submit");
        plan_import(&mut database, plan_input(&mission_id)).unwrap();
        let plan_id: String = database
            .connection()
            .query_row(
                "SELECT plan_id FROM loom_plan WHERE mission_id=?1",
                [&mission_id],
                |row| row.get(0),
            )
            .unwrap();
        task_release(&mut database, release_input(&mission_id, "task_a")).unwrap();
        claim_acquire(
            &mut database,
            claim_input(&mission_id, "task_a", "run_one", "command_one"),
        )
        .unwrap();

        let recorded = candidate_record(
            &mut database,
            candidate_input(&mission_id, "task_a", "run_one", "command_two"),
        )
        .unwrap();
        assert_eq!(
            recorded.mission_id, mission_id,
            "assertion candidate_result_echoes_mission_id"
        );
        assert_eq!(
            recorded.plan_id, plan_id,
            "assertion candidate_result_names_the_plan"
        );
        assert_eq!(
            recorded.agent_run_id, "run_one",
            "assertion candidate_result_keeps_the_fenced_run"
        );
        assert_eq!(
            recorded.content_hash, "sha256:candidate",
            "assertion candidate_result_echoes_content_hash"
        );
        assert_eq!(
            recorded.evidence_ids,
            vec!["evidence_one".to_string(), "evidence_two".to_string()],
            "assertion candidate_result_keeps_evidence_order"
        );
        assert_eq!(
            recorded.verification_status,
            LoomVerificationStatus::Unverified,
            "assertion submitted_candidate_is_unverified"
        );
        assert_eq!(
            recorded.acceptance_status,
            LoomAcceptanceStatus::Pending,
            "assertion submitted_candidate_is_pending_acceptance"
        );
        assert!(
            !recorded.replayed,
            "assertion first_submission_is_not_a_replay"
        );
        assert_eq!(
            task_status(&database, "task_a"),
            "IN_REVIEW",
            "assertion submission_advances_the_task_to_in_review"
        );
        assert_eq!(
            task_revision(&database, "task_a"),
            3,
            "assertion submission_bumps_the_task_revision"
        );
        assert_eq!(
            candidate_rows(&database),
            1,
            "assertion submission_writes_exactly_one_candidate"
        );
        let stored: (String, String, String) = database
            .connection()
            .query_row(
                "SELECT evidence_ids_json, verification_status, acceptance_status
                 FROM loom_candidate WHERE candidate_id=?1",
                [&recorded.candidate_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            stored,
            (
                r#"["evidence_one","evidence_two"]"#.to_string(),
                "UNVERIFIED".to_string(),
                "PENDING".to_string()
            ),
            "assertion candidate_row_stores_evidence_as_a_json_array_and_both_verdicts"
        );
        assert_eq!(
            task_status(&database, "task_b"),
            "DRAFT",
            "assertion submission_leaves_the_other_task_alone"
        );
    }

    #[test]
    fn candidate_record_is_rejected_once_the_lease_expired() {
        let mut database = fixture();
        let mission_id = create_mission(&mut database, "LOOM candidate lease loss");
        let claim = held_task(&mut database, &mission_id, "task_a", "run_one", "command_one");
        expire_lease(&database, &claim.claim_id);

        let error = candidate_record(
            &mut database,
            candidate_input(&mission_id, "task_a", "run_one", "command_two"),
        )
        .unwrap_err();
        assert_eq!(
            command_code(&error),
            LOOM_CLAIM_EXPIRED,
            "assertion an_expired_lease_cannot_submit_a_candidate"
        );
        assert_eq!(
            candidate_rows(&database),
            0,
            "assertion rejected_submission_writes_no_candidate"
        );
        assert_eq!(
            task_status(&database, "task_a"),
            "READY",
            "assertion rejected_submission_keeps_the_task_ready"
        );
        assert_eq!(
            task_revision(&database, "task_a"),
            2,
            "assertion rejected_submission_does_not_bump_the_task_revision"
        );
    }

    #[test]
    fn candidate_record_is_rejected_when_another_run_holds_the_claim() {
        let mut database = fixture();
        let mission_id = create_mission(&mut database, "LOOM candidate fence");
        held_task(&mut database, &mission_id, "task_a", "run_one", "command_one");

        let error = candidate_record(
            &mut database,
            candidate_input(&mission_id, "task_a", "run_two", "command_two"),
        )
        .unwrap_err();
        assert_eq!(
            command_code(&error),
            LOOM_CLAIM_AGENT_RUN_MISMATCH,
            "assertion a_run_that_does_not_hold_the_claim_cannot_submit"
        );
        assert_eq!(
            candidate_rows(&database),
            0,
            "assertion fenced_out_submission_writes_no_candidate"
        );
        assert_eq!(
            task_status(&database, "task_a"),
            "READY",
            "assertion fenced_out_submission_keeps_the_task_ready"
        );
    }

    #[test]
    fn candidate_record_is_rejected_without_an_unreleased_claim() {
        let mut database = fixture();
        let mission_id = create_mission(&mut database, "LOOM candidate no claim");
        plan_import(&mut database, plan_input(&mission_id)).unwrap();
        task_release(&mut database, release_input(&mission_id, "task_a")).unwrap();

        let unclaimed = candidate_record(
            &mut database,
            candidate_input(&mission_id, "task_a", "run_one", "command_two"),
        )
        .unwrap_err();
        assert_eq!(
            command_code(&unclaimed),
            LOOM_CLAIM_ABSENT,
            "assertion an_unclaimed_task_cannot_submit"
        );

        // A claim that was already given up is not a licence either: only an unreleased
        // lease with a live expiry may submit.
        let claim = claim_acquire(
            &mut database,
            claim_input(&mission_id, "task_a", "run_one", "command_one"),
        )
        .unwrap();
        database
            .connection()
            .execute(
                "UPDATE loom_claim SET released_at='2000-01-01T00:00:00+00:00' WHERE claim_id=?1",
                [&claim.claim_id],
            )
            .unwrap();
        let released = candidate_record(
            &mut database,
            candidate_input(&mission_id, "task_a", "run_one", "command_two"),
        )
        .unwrap_err();
        assert_eq!(
            command_code(&released),
            LOOM_CLAIM_ABSENT,
            "assertion a_released_claim_cannot_submit"
        );
        assert_eq!(
            candidate_rows(&database),
            0,
            "assertion claimless_submissions_write_no_candidate"
        );
        assert_eq!(
            task_status(&database, "task_a"),
            "READY",
            "assertion claimless_submissions_keep_the_task_ready"
        );
    }

    #[test]
    fn candidate_record_is_rejected_when_the_criteria_version_differs() {
        let mut database = fixture();
        let mission_id = create_mission(&mut database, "LOOM candidate criteria");
        held_task(&mut database, &mission_id, "task_a", "run_one", "command_one");

        let mut input = candidate_input(&mission_id, "task_a", "run_one", "command_two");
        input.acceptance_criteria_version = "ac-v2".into();
        let error = candidate_record(&mut database, input).unwrap_err();
        assert_eq!(
            command_code(&error),
            LOOM_ACCEPTANCE_CRITERIA_VERSION_MISMATCH,
            "assertion a_candidate_must_name_the_plans_criteria_version"
        );
        assert_eq!(
            candidate_rows(&database),
            0,
            "assertion version_mismatch_writes_no_candidate"
        );
        assert_eq!(
            task_status(&database, "task_a"),
            "READY",
            "assertion version_mismatch_keeps_the_task_ready"
        );
    }

    #[test]
    fn candidate_record_rejects_a_previous_candidate_of_another_task() {
        let mut database = fixture();
        let mission_id = create_mission(&mut database, "LOOM candidate chain");
        held_task(&mut database, &mission_id, "task_a", "run_one", "command_one");
        let first = candidate_record(
            &mut database,
            candidate_input(&mission_id, "task_a", "run_one", "command_two"),
        )
        .unwrap();

        let mut input = candidate_input(&mission_id, "task_b", "run_two", "command_three");
        input.previous_candidate_id = Some(first.candidate_id.clone());
        let error = candidate_record(&mut database, input).unwrap_err();
        assert_eq!(
            command_code(&error),
            LOOM_CANDIDATE_PREVIOUS_INVALID,
            "assertion a_previous_candidate_must_belong_to_the_same_task"
        );
        assert_eq!(
            candidate_rows(&database),
            1,
            "assertion rejected_chain_writes_no_candidate"
        );
    }

    #[test]
    fn replayed_candidate_command_returns_the_original_candidate() {
        let mut database = fixture();
        let mission_id = create_mission(&mut database, "LOOM candidate replay");
        held_task(&mut database, &mission_id, "task_a", "run_one", "command_one");

        let first = candidate_record(
            &mut database,
            candidate_input(&mission_id, "task_a", "run_one", "command_two"),
        )
        .unwrap();
        let replay = candidate_record(
            &mut database,
            candidate_input(&mission_id, "task_a", "run_one", "command_two"),
        )
        .unwrap();
        assert_eq!(
            replay.candidate_id, first.candidate_id,
            "assertion replay_returns_the_original_candidate_id"
        );
        assert!(
            replay.replayed,
            "assertion replay_reports_that_it_replayed"
        );
        assert_eq!(
            replay.content_hash, first.content_hash,
            "assertion replay_does_not_rewrite_the_delivered_content"
        );
        assert_eq!(
            candidate_rows(&database),
            1,
            "assertion replay_writes_no_second_candidate"
        );
        assert_eq!(
            task_revision(&database, "task_a"),
            3,
            "assertion replay_does_not_bump_the_task_revision"
        );

        let reused = candidate_record(
            &mut database,
            candidate_input(&mission_id, "task_b", "run_one", "command_two"),
        )
        .unwrap_err();
        assert_eq!(
            command_code(&reused),
            LOOM_CANDIDATE_COMMAND_REUSED,
            "assertion a_candidate_command_id_cannot_be_reused_for_another_task"
        );

        // The task is already IN_REVIEW, so a fresh command cannot submit a second delivery.
        let twice = candidate_record(
            &mut database,
            candidate_input(&mission_id, "task_a", "run_one", "command_three"),
        )
        .unwrap_err();
        assert_eq!(
            command_code(&twice),
            LOOM_TASK_NOT_READY,
            "assertion a_task_in_review_cannot_take_a_second_delivery"
        );
        assert_eq!(
            candidate_rows(&database),
            1,
            "assertion the_second_delivery_is_refused"
        );
    }

    #[test]
    fn failed_task_transition_rolls_back_the_candidate() {
        let mut database = fixture();
        let mission_id = create_mission(&mut database, "LOOM candidate rollback");
        held_task(&mut database, &mission_id, "task_a", "run_one", "command_one");
        database
            .connection()
            .execute_batch(
                "CREATE TEMP TRIGGER reject_task_update BEFORE UPDATE ON loom_task
                 BEGIN SELECT RAISE(ABORT, 'loom task update rejected'); END;",
            )
            .unwrap();

        let error = candidate_record(
            &mut database,
            candidate_input(&mission_id, "task_a", "run_one", "command_two"),
        )
        .unwrap_err();
        assert!(
            format!("{error:#}").contains("loom task update rejected"),
            "unexpected candidate failure: {error:#}"
        );
        database
            .connection()
            .execute_batch("DROP TRIGGER reject_task_update")
            .unwrap();

        assert_eq!(
            candidate_rows(&database),
            0,
            "assertion failed_transition_leaves_no_orphan_candidate"
        );
        assert_eq!(
            task_status(&database, "task_a"),
            "READY",
            "assertion failed_transition_keeps_the_task_ready"
        );

        // The same command commits as one unit once the fault is gone.
        let retried = candidate_record(
            &mut database,
            candidate_input(&mission_id, "task_a", "run_one", "command_two"),
        )
        .unwrap();
        assert_eq!(
            task_status(&database, "task_a"),
            "IN_REVIEW",
            "assertion retry_after_the_rolled_back_failure_submits"
        );
        assert_eq!(
            candidate_rows(&database),
            1,
            "assertion retry_writes_one_candidate"
        );
        assert!(!retried.replayed, "assertion retry_is_a_fresh_submission");
    }

    #[test]
    fn recorded_candidate_content_cannot_be_rewritten() {
        let mut database = fixture();
        let mission_id = create_mission(&mut database, "LOOM candidate immutable");
        held_task(&mut database, &mission_id, "task_a", "run_one", "command_one");
        let recorded = candidate_record(
            &mut database,
            candidate_input(&mission_id, "task_a", "run_one", "command_two"),
        )
        .unwrap();

        let tampered = database.connection().execute(
            "UPDATE loom_candidate SET content_hash='sha256:tampered' WHERE candidate_id=?1",
            [&recorded.candidate_id],
        );
        assert!(
            tampered.is_err(),
            "assertion a_recorded_candidate_content_is_immutable"
        );
        let stored: String = database
            .connection()
            .query_row(
                "SELECT content_hash FROM loom_candidate WHERE candidate_id=?1",
                [&recorded.candidate_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            stored, "sha256:candidate",
            "assertion the_immutable_guard_keeps_the_original_content_hash"
        );

        // Only the delivered content is frozen; the two verdict axes stay writable for the
        // Review slice that owns them.
        database
            .connection()
            .execute(
                "UPDATE loom_candidate SET acceptance_status='ACCEPTED' WHERE candidate_id=?1",
                [&recorded.candidate_id],
            )
            .unwrap();
        let replay = candidate_record(
            &mut database,
            candidate_input(&mission_id, "task_a", "run_one", "command_two"),
        )
        .unwrap();
        assert!(replay.replayed, "assertion replay_reports_that_it_replayed");
        assert_eq!(
            replay.acceptance_status,
            LoomAcceptanceStatus::Accepted,
            "assertion replay_reads_the_stored_verdict_instead_of_rewriting_it"
        );
    }
}
