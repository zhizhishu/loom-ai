//! LOOM orchestration. Plans, tasks and dependency edges are read-only facts for one
//! Mission; every query is scoped by `missionId`. The only write path is
//! [`plan_import`]: one Mission, one Plan, one transaction.
use std::collections::{HashMap, HashSet};

use anyhow::{Context, Result};
use rusqlite::{OptionalExtension, TransactionBehavior, params};
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

    fn as_str(self) -> &'static str {
        match self {
            Self::TaskDone => "TASK_DONE",
            Self::ArtifactAccepted => "ARTIFACT_ACCEPTED",
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

/// Persisted acceptance criteria accept both the imported `{criterionId,text}` shape and
/// a plain text list; the read model only exposes the texts.
#[derive(Deserialize)]
#[serde(untagged)]
enum StoredCriterion {
    Text(String),
    Described { text: String },
}

fn criteria(raw: &str, owner: &str) -> Result<Vec<String>> {
    let stored: Vec<StoredCriterion> = serde_json::from_str(raw)
        .with_context(|| format!("{owner} acceptance criteria are not a list"))?;
    Ok(stored
        .into_iter()
        .map(|criterion| match criterion {
            StoredCriterion::Text(text) | StoredCriterion::Described { text, .. } => text,
        })
        .collect())
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
        "INSERT INTO loom_plan(plan_id,mission_id,goal,acceptance_criteria_json,created_at,revision)
         VALUES(?1,?2,?3,?4,?5,1)",
        params![&plan_id, mission_id, goal, &acceptance_criteria_json, &now],
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
    for (upstream, downstream, condition) in conditioned_edges {
        let dependency_id = format!("{plan_id}:{upstream}->{downstream}");
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
