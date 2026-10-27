//! LOOM orchestration. Plans, tasks and dependency edges are read-only facts for one
//! Mission; every query is scoped by `missionId`. The only write path is
//! [`plan_import`]: one Mission, one Plan, one transaction.
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
}
