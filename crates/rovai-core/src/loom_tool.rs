//! Agent-side LOOM built-in tools (`rovai loom ...`).
//!
//! The domain transactions stay in [`crate::loom`]; this adapter only decides *who* and *where*.
//! Every identity the domain needs (`missionId`, `agentRunId`, `claimantAgentId`, `commandId`,
//! `claimId`, `fenceGeneration`, `contentHash`, creator) is injected here from the authenticated
//! Run, the current Thread's Mission and persisted rows, never read from the Agent payload. The
//! closed input schemas reject those fields outright.

use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::Digest;

use crate::db::Database;
use crate::loom;

pub const LOOM_STATUS_TOOL_NAME: &str = "loom.status";
pub const LOOM_PLAN_TOOL_NAME: &str = "loom.plan";
pub const LOOM_RELEASE_TOOL_NAME: &str = "loom.release";
pub const LOOM_CLAIM_TOOL_NAME: &str = "loom.claim";
pub const LOOM_EVIDENCE_TOOL_NAME: &str = "loom.evidence";
pub const LOOM_SUBMIT_TOOL_NAME: &str = "loom.submit";
pub const LOOM_INSPECT_TOOL_NAME: &str = "loom.inspect";
pub const LOOM_STAGE_REVIEW_TOOL_NAME: &str = "loom.stage-review";

pub const LOOM_TOOL_NAMES: [&str; 8] = [
    LOOM_STATUS_TOOL_NAME,
    LOOM_PLAN_TOOL_NAME,
    LOOM_RELEASE_TOOL_NAME,
    LOOM_CLAIM_TOOL_NAME,
    LOOM_EVIDENCE_TOOL_NAME,
    LOOM_SUBMIT_TOOL_NAME,
    LOOM_INSPECT_TOOL_NAME,
    LOOM_STAGE_REVIEW_TOOL_NAME,
];

/// Default acceptance-criteria version when the Lead does not name one.
const DEFAULT_ACCEPTANCE_CRITERIA_VERSION: &str = "1";

pub fn is_loom_tool(name: &str) -> bool {
    LOOM_TOOL_NAMES.contains(&name)
}

pub fn is_read_only(name: &str) -> bool {
    matches!(name, LOOM_STATUS_TOOL_NAME | LOOM_INSPECT_TOOL_NAME)
}

/// A rejection with a stable `loom.*` code the CLI maps to `error.recovery`.
#[derive(Debug)]
pub struct LoomToolError {
    code: String,
    message: String,
}

impl LoomToolError {
    fn new(code: impl Into<String>, message: impl Into<String>) -> anyhow::Error {
        anyhow::Error::new(Self {
            code: code.into(),
            message: message.into(),
        })
    }

    pub fn code(&self) -> &str {
        &self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl std::fmt::Display for LoomToolError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for LoomToolError {}

/// Domain codes are `LOOM_PLAN_EXISTS`; the Agent surface uses `loom.plan_exists`.
pub fn agent_error_code(domain_code: &str) -> String {
    let lower = domain_code.to_ascii_lowercase();
    match lower.strip_prefix("loom_") {
        Some(rest) => format!("loom.{rest}"),
        None => format!("loom.{lower}"),
    }
}

/// Translate a domain rejection into a stable Agent error; anything else stays an internal error.
pub fn map_domain_error(error: anyhow::Error) -> anyhow::Error {
    if let Some(rejection) = error.downcast_ref::<loom::LoomCommandError>() {
        return LoomToolError::new(agent_error_code(rejection.code()), rejection.message());
    }
    if let Some(rejection) = error.downcast_ref::<loom::LoomPlanImportError>() {
        return LoomToolError::new(agent_error_code(rejection.code()), rejection.message());
    }
    error
}

/// The authenticated caller, as the dispatcher proved it.
#[derive(Debug, Clone)]
pub struct LoomToolCaller<'a> {
    pub camp_id: &'a str,
    pub agent_id: &'a str,
    pub agent_run_id: &'a str,
    /// Already scoped to the Run by the dispatcher, so a retry in one Run replays and a later
    /// Run cannot collide with the same provider call id.
    pub command_id: &'a str,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LoomStatusToolInput {}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoomPlanToolInput {
    pub goal: String,
    #[serde(default)]
    pub acceptance_criteria_version: Option<String>,
    pub criteria: Vec<loom::LoomPlanImportCriterion>,
    pub tasks: Vec<loom::LoomPlanImportTask>,
    #[serde(default)]
    pub dependencies: Vec<loom::LoomPlanImportDependency>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoomReleaseToolInput {
    pub task_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoomClaimToolInput {
    pub task_id: String,
    #[serde(default)]
    pub lease_seconds: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoomEvidenceToolInput {
    pub relative_path: String,
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub content_type: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoomSubmitToolInput {
    pub task_id: String,
    pub evidence_ids: Vec<String>,
    #[serde(default)]
    pub previous_candidate_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoomInspectToolInput {
    pub task_id: String,
}

/// The stage-review tool speaks the domain input verbatim, so the closed CLI schema and the
/// domain validation cannot drift apart and no adapter field can become a second source of truth.
pub type LoomStageReviewToolInput = loom::control::LoomStageReviewInput;

/// Schema-level validation used by the closed tool catalog.
pub fn validate_input(name: &str, input: &Value) -> Result<()> {
    match name {
        LOOM_STATUS_TOOL_NAME => {
            serde_json::from_value::<LoomStatusToolInput>(input.clone()).map(|_| ())
        }
        LOOM_PLAN_TOOL_NAME => {
            serde_json::from_value::<LoomPlanToolInput>(input.clone()).map(|_| ())
        }
        LOOM_RELEASE_TOOL_NAME => {
            serde_json::from_value::<LoomReleaseToolInput>(input.clone()).map(|_| ())
        }
        LOOM_CLAIM_TOOL_NAME => {
            serde_json::from_value::<LoomClaimToolInput>(input.clone()).map(|_| ())
        }
        LOOM_EVIDENCE_TOOL_NAME => {
            serde_json::from_value::<LoomEvidenceToolInput>(input.clone()).map(|_| ())
        }
        LOOM_SUBMIT_TOOL_NAME => {
            serde_json::from_value::<LoomSubmitToolInput>(input.clone()).map(|_| ())
        }
        LOOM_INSPECT_TOOL_NAME => {
            serde_json::from_value::<LoomInspectToolInput>(input.clone()).map(|_| ())
        }
        LOOM_STAGE_REVIEW_TOOL_NAME => {
            let input = serde_json::from_value::<LoomStageReviewToolInput>(input.clone())
                .map_err(|error| LoomToolError::new("loom.invalid_input", error.to_string()))?;
            return loom::control::validate_stage_review_shape(
                &input.task_id,
                &input.candidate_id,
                &input.manifest_hash,
                &input.reason,
                input.policy_revision,
                &input.criteria_results,
            )
            .map_err(map_domain_error);
        }
        _ => anyhow::bail!("unknown LOOM tool {name}"),
    }
    .map_err(|error| LoomToolError::new("loom.invalid_input", error.to_string()))
}

/// Run one LOOM tool for the authenticated caller.
pub fn invoke(
    database: &mut Database,
    caller: &LoomToolCaller<'_>,
    name: &str,
    input: Value,
) -> Result<Value> {
    // Full closed-schema check (lengths, enums, item shapes) as well as the serde shape; Core
    // never trusts that the CLI validated before sending.
    crate::team_tool_catalog::validate_builtin_tool_input(name, &input)
        .map_err(|error| LoomToolError::new("loom.invalid_input", format!("{error:#}")))?;
    let mission_id = current_mission_id(database.connection(), caller.camp_id)?;
    match name {
        LOOM_STATUS_TOOL_NAME => status(database, &mission_id),
        LOOM_PLAN_TOOL_NAME => {
            require_default_lead(database.connection(), caller)?;
            let input: LoomPlanToolInput = serde_json::from_value(input)?;
            let result = loom::plan_import(
                database,
                loom::LoomPlanImportInput {
                    mission_id,
                    goal: input.goal,
                    acceptance_criteria_version: input
                        .acceptance_criteria_version
                        .unwrap_or_else(|| DEFAULT_ACCEPTANCE_CRITERIA_VERSION.to_string()),
                    criteria: input.criteria,
                    tasks: input.tasks,
                    dependencies: input.dependencies,
                },
            )
            .map_err(map_domain_error)?;
            Ok(serde_json::to_value(result)?)
        }
        LOOM_RELEASE_TOOL_NAME => {
            require_default_lead(database.connection(), caller)?;
            let input: LoomReleaseToolInput = serde_json::from_value(input)?;
            let result = loom::task_release(
                database,
                loom::LoomTaskReleaseInput {
                    mission_id,
                    task_id: input.task_id,
                },
            )
            .map_err(map_domain_error)?;
            // Canonical results may not carry a top-level `task` object, so the released
            // Task's fields are flattened beside the plan identity.
            let mut output = serde_json::to_value(&result.task)?;
            if let Some(object) = output.as_object_mut() {
                object.insert("missionId".into(), json!(result.mission_id));
                object.insert("planId".into(), json!(result.plan_id));
            }
            Ok(output)
        }
        LOOM_CLAIM_TOOL_NAME => {
            let input: LoomClaimToolInput = serde_json::from_value(input)?;
            let result = loom::claim_acquire(
                database,
                loom::LoomClaimAcquireInput {
                    mission_id,
                    task_id: input.task_id,
                    agent_run_id: caller.agent_run_id.to_string(),
                    claimant_agent_id: Some(caller.agent_id.to_string()),
                    command_id: caller.command_id.to_string(),
                    lease_seconds: input.lease_seconds,
                },
            )
            .map_err(map_domain_error)?;
            Ok(serde_json::to_value(result)?)
        }
        LOOM_EVIDENCE_TOOL_NAME => {
            let input: LoomEvidenceToolInput = serde_json::from_value(input)?;
            let result = loom::artifact_register(
                database,
                caller.agent_id,
                loom::LoomArtifactRegisterInput {
                    mission_id,
                    task_id: input.task_id,
                    agent_run_id: Some(caller.agent_run_id.to_string()),
                    relative_path: input.relative_path,
                    content_type: input.content_type,
                },
            )
            .map_err(map_domain_error)?;
            Ok(serde_json::to_value(result)?)
        }
        LOOM_SUBMIT_TOOL_NAME => {
            let input: LoomSubmitToolInput = serde_json::from_value(input)?;
            submit(database, caller, &mission_id, input)
        }
        LOOM_INSPECT_TOOL_NAME => {
            let input: LoomInspectToolInput = serde_json::from_value(input)?;
            inspect(database, &mission_id, &input.task_id)
        }
        LOOM_STAGE_REVIEW_TOOL_NAME => {
            let input: LoomStageReviewToolInput = serde_json::from_value(input)?;
            // Everything that makes the verdict trustworthy (agent, Run, command id) is the
            // authenticated caller; the payload only names what was reviewed and the verdict.
            let result = loom::control::stage_review_record(
                database,
                &mission_id,
                caller.agent_id,
                caller.agent_run_id,
                caller.command_id,
                input,
            )
            .map_err(map_domain_error)?;
            Ok(serde_json::to_value(result)?)
        }
        _ => Err(LoomToolError::new(
            "loom.invalid_input",
            format!("unknown LOOM tool {name}"),
        )),
    }
}

fn current_mission_id(connection: &Connection, camp_id: &str) -> Result<String> {
    connection
        .query_row(
            "SELECT mission.id FROM mission JOIN camp ON camp.id=mission.camp_id
             WHERE mission.camp_id=?1 AND camp.deletion_operation_id IS NULL",
            [camp_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| {
            LoomToolError::new(
                "loom.current_unavailable",
                "The current Thread has no Mission; LOOM works inside a Mission Thread",
            )
        })
}

fn require_default_lead(connection: &Connection, caller: &LoomToolCaller<'_>) -> Result<()> {
    let is_lead: bool = connection
        .query_row(
            "SELECT default_lead_agent_id = ?2 FROM camp WHERE id = ?1",
            params![caller.camp_id, caller.agent_id],
            |row| row.get::<_, Option<bool>>(0),
        )
        .optional()?
        .flatten()
        .unwrap_or(false);
    if is_lead {
        Ok(())
    } else {
        Err(LoomToolError::new(
            "loom.lead_required",
            "Only the current Thread Default Lead can import or release a LOOM plan",
        ))
    }
}

fn status(database: &Database, mission_id: &str) -> Result<Value> {
    let plan = loom::plan_get(database, mission_id)?;
    let tasks = loom::tasks_list(database, mission_id)?;
    let dependencies = loom::dependencies_list(database, mission_id)?;
    let claims = loom::claims_list(database, mission_id)?;
    Ok(json!({
        "missionId": mission_id,
        "plan": plan,
        "tasks": tasks,
        "dependencies": dependencies,
        "claims": claims.claims,
        "evaluatedAt": claims.evaluated_at,
    }))
}

/// Read one task's latest candidate and the authorization that governs reviewing it.
///
/// This decides nothing: it is the read a reviewer takes before `loom.stage-review`, and it never
/// approves, accepts or records anything. Every identity it shows comes from persisted rows and
/// the trusted Mission, never from the caller's payload.
fn inspect(database: &Database, mission_id: &str, task_id: &str) -> Result<Value> {
    let tasks = loom::tasks_list(database, mission_id)?;
    let task = tasks
        .iter()
        .find(|task| task.task_id == task_id)
        .cloned()
        .ok_or_else(|| {
            LoomToolError::new(
                "loom.task_not_found",
                format!("task {task_id} is not part of the current Mission's plan"),
            )
        })?;
    let latest = latest_candidate_id(database.connection(), mission_id, task_id)?;
    let candidate = match &latest {
        Some(candidate_id) => loom::candidates_list(database, mission_id)?
            .into_iter()
            .find(|candidate| &candidate.candidate_id == candidate_id),
        None => None,
    };
    let manifest_hash = match &candidate {
        Some(candidate) => Some(
            loom::control::candidate_manifest_hash(database.connection(), &candidate.candidate_id)
                .map_err(map_domain_error)?,
        ),
        None => None,
    };
    // One read of the control plane gives the authorization revision, the assigned reviewer of
    // this task and the stage history, all from the same instant.
    let control = loom::control::get(database, mission_id)?;
    let policy_revision = control
        .policy
        .as_ref()
        .map(|policy| policy.authorization_revision);
    let reviewer_agent_id = control.policy.as_ref().and_then(|policy| {
        policy
            .reviewers
            .iter()
            .find(|reviewer| reviewer.task_id == task_id)
            .map(|reviewer| reviewer.reviewer_agent_id.clone())
    });
    let stage_reviews: Vec<_> = control
        .stage_reviews
        .into_iter()
        .filter(|review| review.task_id == task_id)
        .collect();
    let artifacts = match &candidate {
        Some(candidate) => loom::artifacts_list(database, mission_id)?
            .artifacts
            .into_iter()
            .filter(|artifact| {
                candidate
                    .evidence_ids
                    .iter()
                    .any(|id| id == &artifact.artifact_id)
            })
            .collect::<Vec<_>>(),
        None => Vec::new(),
    };
    // The read a reviewer needs is not only what was delivered but the exact shape it must
    // submit. The schema below is the closed catalog's own `loom.stage-review` input schema,
    // so this guidance cannot drift from the validation Core applies, and the only values
    // filled in are the facts this response already read: no verdict and no criterion
    // result is suggested, because a submission is the reviewer's judgement to make.
    let stage_review_schema = stage_review_input_schema();
    let criterion_ids: Vec<String> = task
        .acceptance_criteria
        .criteria
        .iter()
        .map(|criterion| criterion.criterion_id.clone())
        .collect();
    let review_submission = json!({
        "tool": LOOM_STAGE_REVIEW_TOOL_NAME,
        "cli": "rovai loom stage-review --input-file review.json",
        "prefilled": {
            "taskId": task.task_id.clone(),
            "candidateId": candidate
                .as_ref()
                .map(|candidate| candidate.candidate_id.clone()),
            "policyRevision": policy_revision,
            "manifestHash": manifest_hash.clone(),
        },
        "criterionIds": criterion_ids,
        "required": stage_review_schema
            .get("required")
            .cloned()
            .unwrap_or_else(|| json!([])),
        "inputSchema": stage_review_schema,
        "guidance": "Write one JSON object with exactly these required fields and pass it with \
`--input-file`. Each criteriaResults entry is {criterionId, satisfied, evidenceIds?, note?}; \
`satisfied` is a boolean and there is no `passed` field. Answer every criterionId listed here \
exactly once, and cite only evidence of this candidate. Copy policyRevision and manifestHash \
from this response instead of inventing them. This object is guidance only: it records nothing, \
approves nothing, and only the User accepts a delivery.",
    });
    Ok(json!({
        "task": task,
        "candidate": candidate,
        "manifestHash": manifest_hash,
        "policyRevision": policy_revision,
        "reviewerAgentId": reviewer_agent_id,
        "stageReviews": stage_reviews,
        "artifacts": artifacts,
        "reviewSubmission": review_submission,
        "evaluatedAt": control.evaluated_at,
    }))
}

/// The closed catalog's `loom.stage-review` input schema, read from the same definitions the
/// dispatcher validates against, so a reviewer's guidance and Core's refusal cannot diverge.
fn stage_review_input_schema() -> Value {
    crate::team_tool_catalog::builtin_tool_definitions()
        .iter()
        .find(|definition| {
            definition.get("name").and_then(Value::as_str) == Some(LOOM_STAGE_REVIEW_TOOL_NAME)
        })
        .and_then(|definition| definition.get("inputSchema").cloned())
        .unwrap_or(Value::Null)
}

/// The newest candidate of one task: creation order first, then the order the store assigned.
fn latest_candidate_id(
    connection: &Connection,
    mission_id: &str,
    task_id: &str,
) -> Result<Option<String>> {
    Ok(connection
        .query_row(
            "SELECT candidate.candidate_id
             FROM loom_candidate AS candidate
             JOIN loom_plan AS plan ON plan.plan_id=candidate.plan_id
             WHERE plan.mission_id=?1 AND candidate.task_id=?2
             ORDER BY candidate.created_at DESC, candidate.rowid DESC
             LIMIT 1",
            params![mission_id, task_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?)
}

/// Submit binds to this Run's own claim. The newest claim the Run ever held on the task is
/// passed through even when released or expired, so a replay after the first submission
/// moved the Task still reaches the domain's command-id replay check before any fence check.
fn submit(
    database: &mut Database,
    caller: &LoomToolCaller<'_>,
    mission_id: &str,
    input: LoomSubmitToolInput,
) -> Result<Value> {
    let claims = loom::claims_list(database, mission_id)?;
    let claim = claims
        .claims
        .iter()
        .filter(|claim| claim.task_id == input.task_id && claim.agent_run_id == caller.agent_run_id)
        .max_by_key(|claim| claim.fence_generation)
        .ok_or_else(|| {
            LoomToolError::new(
                "loom.claim_absent",
                format!(
                    "this Run holds no claim on task {}; run `rovai loom claim --task-id {}` first",
                    input.task_id, input.task_id
                ),
            )
        })?;
    let plan = loom::plan_get(database, mission_id)?.ok_or_else(|| {
        LoomToolError::new(
            "loom.plan_not_found",
            "The current Mission has no LOOM plan",
        )
    })?;
    let content_hash = candidate_content_hash(database, mission_id, &input.evidence_ids)?;
    let result = loom::candidate_record(
        database,
        loom::LoomCandidateRecordInput {
            mission_id: mission_id.to_string(),
            task_id: input.task_id,
            agent_run_id: caller.agent_run_id.to_string(),
            claim_id: claim.claim_id.clone(),
            fence_generation: claim.fence_generation,
            command_id: caller.command_id.to_string(),
            content_hash,
            evidence_ids: input.evidence_ids,
            acceptance_criteria_version: plan.acceptance_criteria.version,
            previous_candidate_id: input.previous_candidate_id,
        },
    )
    .map_err(map_domain_error)?;
    Ok(serde_json::to_value(result)?)
}

/// The candidate's content identity: SHA-256 over the sorted (artifactId, sha256) pairs of its
/// registered evidence. Unregistered ids hash as such and are then refused by the domain, which
/// owns the "must be a registered artifact of this plan" rule.
fn candidate_content_hash(
    database: &Database,
    mission_id: &str,
    evidence_ids: &[String],
) -> Result<String> {
    let artifacts = loom::artifacts_list(database, mission_id)?;
    let mut pairs: Vec<(String, String)> = evidence_ids
        .iter()
        .map(|id| {
            let digest = artifacts
                .artifacts
                .iter()
                .find(|artifact| artifact.artifact_id == *id)
                .map(|artifact| artifact.sha256.clone())
                .unwrap_or_default();
            (id.trim().to_string(), digest)
        })
        .collect();
    pairs.sort();
    pairs.dedup();
    let canonical = serde_json::to_string(&pairs)?;
    Ok(format!("sha256:{}", hex_digest(canonical.as_bytes())))
}

fn hex_digest(bytes: &[u8]) -> String {
    sha2::Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn id_schema() -> Value {
    json!({"type": "string", "minLength": 1, "maxLength": 200})
}

fn open_object() -> Value {
    json!({"type": "object"})
}

/// The eight closed tool definitions, in `TEAM_TOOL_NAMES` order. Model-visible text follows the
/// confirmed revision of `docs/versions/v1.72/model-context-change-loom-accp.md` (the `loom.plan`
/// description is r3), and the two control tools follow the confirmed r1 of
/// `docs/versions/v1.72/model-context-change-loom-control.md`. Edit that text only through a new
/// revision.
pub fn tool_definitions() -> Vec<Value> {
    let criterion = json!({
        "type": "object", "additionalProperties": false, "required": ["criterionId", "text"],
        "properties": {"criterionId": id_schema(), "text": {"type": "string", "minLength": 1, "maxLength": 2000}}
    });
    let task = json!({
        "type": "object", "additionalProperties": false, "required": ["taskId", "title"],
        "properties": {
            "taskId": id_schema(),
            "title": {"type": "string", "minLength": 1, "maxLength": 200},
            "description": {"type": "string", "maxLength": 12000},
            "assigneeAgentId": id_schema()
        }
    });
    let dependency = json!({
        "type": "object", "additionalProperties": false, "required": ["upstreamTaskId", "downstreamTaskId"],
        "properties": {
            "upstreamTaskId": id_schema(),
            "downstreamTaskId": id_schema(),
            "condition": {"type": "string", "enum": ["task_done", "artifact_accepted"]}
        }
    });
    vec![
        json!({
            "name": LOOM_STATUS_TOOL_NAME,
            "title": "Read the current Mission's LOOM plan",
            "description": "Read the current Mission's plan, tasks, dependencies and claims. Returns `plan: null` when no plan exists.",
            "inputSchema": {"type": "object", "additionalProperties": false, "properties": {}},
            "outputSchema": {
                "type": "object",
                "required": ["missionId", "plan", "tasks", "dependencies", "claims", "evaluatedAt"],
                "properties": {
                    "missionId": {"type": "string"},
                    "plan": {"type": ["object", "null"]},
                    "tasks": {"type": "array", "items": open_object()},
                    "dependencies": {"type": "array", "items": open_object()},
                    "claims": {"type": "array", "items": open_object()},
                    "evaluatedAt": {"type": "string"}
                }
            }
        }),
        json!({
            "name": LOOM_PLAN_TOOL_NAME,
            "title": "Import the current Mission's plan",
            "description": "Import the current Mission's one LOOM plan. Default Lead only. A Mission accepts one plan; it cannot be replaced. Does not start work; release tasks and message members separately. Pass the plan as JSON with --input-file; the exact file shape is in the cli-operations LOOM reference.",
            "inputSchema": {
                "type": "object", "additionalProperties": false,
                "required": ["goal", "criteria", "tasks"],
                "properties": {
                    "goal": {"type": "string", "minLength": 1, "maxLength": 2000},
                    "acceptanceCriteriaVersion": {"type": "string", "minLength": 1, "maxLength": 100},
                    "criteria": {"type": "array", "minItems": 1, "items": criterion},
                    "tasks": {"type": "array", "minItems": 1, "items": task},
                    "dependencies": {"type": "array", "items": dependency}
                }
            },
            "outputSchema": {
                "type": "object",
                "required": ["planId", "missionId", "acceptanceCriteriaVersion", "taskIds", "dependencyIds"],
                "properties": {
                    "planId": {"type": "string"},
                    "missionId": {"type": "string"},
                    "acceptanceCriteriaVersion": {"type": "string"},
                    "taskIds": {"type": "array", "items": {"type": "string"}},
                    "dependencyIds": {"type": "array", "items": {"type": "string"}}
                }
            }
        }),
        json!({
            "name": LOOM_RELEASE_TOOL_NAME,
            "title": "Release a planned task",
            "description": "Make a draft task claimable. Default Lead only. Releasing does not check dependencies; claiming a task whose dependencies are not yet met returns loom.dependency_unreleased.",
            "inputSchema": {
                "type": "object", "additionalProperties": false, "required": ["taskId"],
                "properties": {"taskId": id_schema()}
            },
            "outputSchema": {
                "type": "object",
                "required": ["taskId", "planId", "missionId", "status"],
                "properties": {
                    "taskId": {"type": "string"},
                    "planId": {"type": "string"},
                    "missionId": {"type": "string"},
                    "status": {"type": "string"}
                }
            }
        }),
        json!({
            "name": LOOM_CLAIM_TOOL_NAME,
            "title": "Claim a task",
            "description": "Claim a released task for this Run. A later valid claim by another Run replaces an expired one.",
            "inputSchema": {
                "type": "object", "additionalProperties": false, "required": ["taskId"],
                "properties": {
                    "taskId": id_schema(),
                    "leaseSeconds": {"type": "integer", "minimum": 1, "maximum": 3600}
                }
            },
            "outputSchema": {
                "type": "object",
                "required": ["claimId", "taskId", "fenceGeneration", "leaseExpiresAt", "replayed"],
                "properties": {
                    "claimId": {"type": "string"},
                    "taskId": {"type": "string"},
                    "fenceGeneration": {"type": "integer"},
                    "leaseExpiresAt": {"type": "string"},
                    "replayed": {"type": "boolean"}
                }
            }
        }),
        json!({
            "name": LOOM_EVIDENCE_TOOL_NAME,
            "title": "Register delivery evidence",
            "description": "Register a file you produced as evidence. `relativePath` is relative to this Mission's working directory; Core hashes the bytes on disk.",
            "inputSchema": {
                "type": "object", "additionalProperties": false, "required": ["relativePath"],
                "properties": {
                    "relativePath": {"type": "string", "minLength": 1, "maxLength": 1000},
                    "taskId": id_schema(),
                    "contentType": {"type": "string", "minLength": 1, "maxLength": 200}
                }
            },
            "outputSchema": {
                "type": "object",
                "required": ["artifact", "replayed"],
                "properties": {
                    "artifact": {
                        "type": "object",
                        "required": ["artifactId", "relativePath", "sha256", "sizeBytes"],
                        "properties": {
                            "artifactId": {"type": "string"},
                            "relativePath": {"type": "string"},
                            "sha256": {"type": "string"},
                            "sizeBytes": {"type": "integer"}
                        }
                    },
                    "replayed": {"type": "boolean"}
                }
            }
        }),
        json!({
            "name": LOOM_SUBMIT_TOOL_NAME,
            "title": "Submit a delivery",
            "description": "Submit this Run's claimed task for User acceptance with registered evidence. Does not accept the delivery.",
            "inputSchema": {
                "type": "object", "additionalProperties": false, "required": ["taskId", "evidenceIds"],
                "properties": {
                    "taskId": id_schema(),
                    "evidenceIds": {"type": "array", "items": id_schema()},
                    "previousCandidateId": id_schema()
                }
            },
            "outputSchema": {
                "type": "object",
                "required": ["candidateId", "taskId", "verificationStatus", "acceptanceStatus", "replayed"],
                "properties": {
                    "candidateId": {"type": "string"},
                    "taskId": {"type": "string"},
                    "verificationStatus": {"type": "string"},
                    "acceptanceStatus": {"type": "string"},
                    "replayed": {"type": "boolean"}
                }
            }
        }),
        json!({
            "name": LOOM_INSPECT_TOOL_NAME,
            "title": "Inspect a candidate for stage review",
            "description": "Read a task's latest candidate, registered evidence, review manifest and current review authorization in this Mission. Reading does not approve or accept anything.",
            "inputSchema": {
                "type": "object", "additionalProperties": false, "required": ["taskId"],
                "properties": {"taskId": id_schema()}
            },
            "outputSchema": {
                "type": "object",
                "required": ["task", "candidate", "manifestHash", "policyRevision",
                    "reviewerAgentId", "stageReviews", "artifacts", "evaluatedAt"],
                "properties": {
                    "task": open_object(),
                    "candidate": {"type": ["object", "null"]},
                    "manifestHash": {"type": ["string", "null"]},
                    "policyRevision": {"type": ["integer", "null"]},
                    "reviewerAgentId": {"type": ["string", "null"]},
                    "stageReviews": {"type": "array", "items": open_object()},
                    "artifacts": {"type": "array", "items": open_object()},
                    // Additive, read-only guidance for the submission this reviewer has to make.
                    // It stays out of `required` so a projection recorded before it existed keeps
                    // validating; the emitted shape itself is proven by this module's owner test.
                    "reviewSubmission": open_object(),
                    "evaluatedAt": {"type": "string"}
                }
            }
        }),
        json!({
            "name": LOOM_STAGE_REVIEW_TOOL_NAME,
            "title": "Record an authorized stage review",
            "description": "Review the inspected candidate under the User-approved task assignment. Pass is internal approval only. Request changes returns this task for a new candidate. Blocked stops this task for the User. You cannot review your own output or accept a delivery for the User.",
            "inputSchema": {
                "type": "object", "additionalProperties": false,
                "required": ["taskId", "candidateId", "policyRevision", "manifestHash",
                    "verdict", "reason", "criteriaResults"],
                "properties": {
                    "taskId": id_schema(),
                    "candidateId": id_schema(),
                    "policyRevision": {"type": "integer", "minimum": 1},
                    "manifestHash": {"type": "string", "pattern": "^[0-9a-f]{64}$"},
                    "verdict": {"type": "string", "enum": ["pass", "request_changes", "blocked"]},
                    "reason": {"type": "string", "minLength": 1, "maxLength": 4000},
                    "criteriaResults": {
                        "type": "array", "minItems": 1, "maxItems": 100,
                        "items": {
                            "type": "object", "additionalProperties": false,
                            "required": ["criterionId", "satisfied"],
                            "properties": {
                                "criterionId": id_schema(),
                                "satisfied": {"type": "boolean"},
                                "evidenceIds": {
                                    "type": "array", "maxItems": 100, "items": id_schema()
                                },
                                "note": {
                                    "type": ["string", "null"], "maxLength": 4000
                                }
                            }
                        }
                    }
                }
            },
            "outputSchema": {
                "type": "object",
                "required": ["review", "taskStatus", "replayed"],
                "properties": {
                    "review": {
                        "type": "object",
                        "required": ["stageReviewId", "taskId", "candidateId",
                            "reviewerAgentId", "reviewerAgentRunId", "policyRevision",
                            "manifestHash", "verdict", "reason", "criteriaResults",
                            "reviewedAt"],
                        "properties": {
                            "stageReviewId": {"type": "string"},
                            "taskId": {"type": "string"},
                            "candidateId": {"type": "string"},
                            "reviewerAgentId": {"type": "string"},
                            "reviewerAgentRunId": {"type": "string"},
                            "policyRevision": {"type": "integer"},
                            "manifestHash": {"type": "string"},
                            "verdict": {"type": "string", "enum": ["pass", "request_changes", "blocked"]},
                            "reason": {"type": "string"},
                            "criteriaResults": {"type": "array", "items": open_object()},
                            "reviewedAt": {"type": "string"}
                        }
                    },
                    // A replay reports the stored verdict's status, not the Task's current one:
                    // pass → `in_review`, request_changes → `ready`, blocked → `blocked`.
                    "taskStatus": {"type": "string", "enum": ["in_review", "ready", "blocked"]},
                    "replayed": {"type": "boolean"}
                }
            }
        }),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn definitions_follow_the_tool_name_order() {
        let names: Vec<String> = tool_definitions()
            .iter()
            .map(|definition| definition["name"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(names, LOOM_TOOL_NAMES);
    }

    use crate::collaboration::ProjectBindingKind;
    use crate::command::{ActorRef, CommandEnvelope};
    use crate::mission::{CreateMissionCommand, MissionService};
    use crate::test_support::OwnedTestDatabase;

    fn fixture() -> OwnedTestDatabase {
        crate::test_support::seeded_runtime_database_owned()
    }

    /// A Mission led by `agent_1` in a fresh directory workspace; returns (missionId, campId).
    fn mission(database: &mut OwnedTestDatabase, title: &str) -> (String, String) {
        let workspace = database
            .directory()
            .join(format!("loom-tool-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&workspace).unwrap();
        let created = MissionService::default()
            .create(
                database,
                &CommandEnvelope {
                    command_id: uuid::Uuid::new_v4().to_string(),
                    actor: ActorRef::User {
                        user_id: "local_user".into(),
                    },
                    camp_id: None,
                    expected_versions: Vec::new(),
                    execution_epoch: None,
                    payload: CreateMissionCommand {
                        team: None,
                        title: title.into(),
                        description: String::new(),
                        description_content: None,
                        project_path: workspace.to_string_lossy().into_owned(),
                        project_binding_kind: ProjectBindingKind::Directory,
                        member_agent_ids: vec!["agent_1".into(), "agent_2".into()],
                        default_lead_agent_id: "agent_1".into(),
                        tags: vec![],
                        source_attachments: vec![],
                    },
                },
            )
            .unwrap();
        let mission_id = created.result.payload["missionId"]
            .as_str()
            .unwrap()
            .to_string();
        let camp_id: String = database
            .connection()
            .query_row(
                "SELECT camp_id FROM mission WHERE id=?1",
                [&mission_id],
                |row| row.get(0),
            )
            .unwrap();
        (mission_id, camp_id)
    }

    fn caller<'a>(
        camp_id: &'a str,
        agent_id: &'a str,
        run: &'a str,
        command: &'a str,
    ) -> LoomToolCaller<'a> {
        LoomToolCaller {
            camp_id,
            agent_id,
            agent_run_id: run,
            command_id: command,
        }
    }

    fn plan_json() -> Value {
        json!({
            "goal": "Write the report",
            "criteria": [{"criterionId": "c1", "text": "Report exists"}],
            "tasks": [{"taskId": "t1", "title": "Draft"}, {"taskId": "t2", "title": "Review"}],
            "dependencies": [{"upstreamTaskId": "t1", "downstreamTaskId": "t2"}]
        })
    }

    fn code(error: anyhow::Error) -> String {
        error
            .downcast_ref::<LoomToolError>()
            .unwrap_or_else(|| panic!("expected a LOOM tool rejection, got: {error:#}"))
            .code()
            .to_string()
    }

    #[test]
    fn a_thread_without_a_mission_is_refused() {
        let mut database = fixture();
        let error = invoke(
            &mut database,
            &caller("camp_without_mission", "agent_1", "run_1", "cmd_1"),
            LOOM_STATUS_TOOL_NAME,
            json!({}),
        )
        .unwrap_err();
        assert_eq!(code(error), "loom.current_unavailable");
    }

    #[test]
    fn only_the_default_lead_plans_and_releases() {
        let mut database = fixture();
        let (_, camp_id) = mission(&mut database, "LOOM lead gate");
        let error = invoke(
            &mut database,
            &caller(&camp_id, "agent_2", "run_member", "cmd_plan_member"),
            LOOM_PLAN_TOOL_NAME,
            plan_json(),
        )
        .unwrap_err();
        assert_eq!(code(error), "loom.lead_required");
        invoke(
            &mut database,
            &caller(&camp_id, "agent_1", "run_lead", "cmd_plan_lead"),
            LOOM_PLAN_TOOL_NAME,
            plan_json(),
        )
        .unwrap();
        let error = invoke(
            &mut database,
            &caller(&camp_id, "agent_2", "run_member", "cmd_release_member"),
            LOOM_RELEASE_TOOL_NAME,
            json!({"taskId": "t1"}),
        )
        .unwrap_err();
        assert_eq!(code(error), "loom.lead_required");
        let error = invoke(
            &mut database,
            &caller(&camp_id, "agent_1", "run_lead", "cmd_plan_again"),
            LOOM_PLAN_TOOL_NAME,
            plan_json(),
        )
        .unwrap_err();
        assert_eq!(
            code(error),
            "loom.plan_exists",
            "a second plan is never imported"
        );
    }

    #[test]
    fn the_full_agent_chain_injects_identity_and_stays_inside_its_mission() {
        let mut database = fixture();
        let (mission_id, camp_id) = mission(&mut database, "LOOM chain");
        let (_, other_camp) = mission(&mut database, "LOOM other");
        let lead = caller(&camp_id, "agent_1", "run_lead", "cmd_plan");
        invoke(&mut database, &lead, LOOM_PLAN_TOOL_NAME, plan_json()).unwrap();
        let released = invoke(
            &mut database,
            &caller(&camp_id, "agent_1", "run_lead", "cmd_release"),
            LOOM_RELEASE_TOOL_NAME,
            json!({"taskId": "t1"}),
        )
        .unwrap();
        assert_eq!(released["status"], "ready");
        assert!(
            released.get("task").is_none(),
            "canonical results carry no top-level task"
        );
        // r2 guidance: the Lead releases every task at once; the dependency gate is the claim.
        invoke(
            &mut database,
            &caller(&camp_id, "agent_1", "run_lead", "cmd_release_downstream"),
            LOOM_RELEASE_TOOL_NAME,
            json!({"taskId": "t2"}),
        )
        .unwrap();
        let error = invoke(
            &mut database,
            &caller(&camp_id, "agent_2", "run_early", "cmd_claim_downstream"),
            LOOM_CLAIM_TOOL_NAME,
            json!({"taskId": "t2"}),
        )
        .unwrap_err();
        assert_eq!(code(error), "loom.dependency_unreleased");

        // The other Mission has no plan: the same task id is not reachable from there.
        let error = invoke(
            &mut database,
            &caller(&other_camp, "agent_2", "run_other", "cmd_cross"),
            LOOM_CLAIM_TOOL_NAME,
            json!({"taskId": "t1"}),
        )
        .unwrap_err();
        assert_eq!(code(error), "loom.plan_not_found");

        // Submitting before claiming names the missing step.
        let error = invoke(
            &mut database,
            &caller(&camp_id, "agent_2", "run_worker", "cmd_early_submit"),
            LOOM_SUBMIT_TOOL_NAME,
            json!({"taskId": "t1", "evidenceIds": []}),
        )
        .unwrap_err();
        assert_eq!(code(error), "loom.claim_absent");

        let claim = invoke(
            &mut database,
            &caller(&camp_id, "agent_2", "run_worker", "cmd_claim"),
            LOOM_CLAIM_TOOL_NAME,
            json!({"taskId": "t1"}),
        )
        .unwrap();
        assert_eq!(
            claim["agentRunId"], "run_worker",
            "the Run comes from authentication"
        );
        assert_eq!(claim["claimantAgentId"], "agent_2");
        let replayed = invoke(
            &mut database,
            &caller(&camp_id, "agent_2", "run_worker", "cmd_claim"),
            LOOM_CLAIM_TOOL_NAME,
            json!({"taskId": "t1"}),
        )
        .unwrap();
        assert_eq!(replayed["claimId"], claim["claimId"]);
        assert_eq!(replayed["replayed"], true);

        let workspace = std::path::PathBuf::from(
            database
                .connection()
                .query_row(
                    "SELECT camp.project_path FROM mission JOIN camp ON camp.id=mission.camp_id WHERE mission.id=?1",
                    [&mission_id],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
        );
        std::fs::write(workspace.join("report.md"), "draft report").unwrap();
        let evidence = invoke(
            &mut database,
            &caller(&camp_id, "agent_2", "run_worker", "cmd_evidence"),
            LOOM_EVIDENCE_TOOL_NAME,
            json!({"relativePath": "report.md", "taskId": "t1"}),
        )
        .unwrap();
        assert_eq!(evidence["artifact"]["creatorId"], "agent_2");
        assert_eq!(evidence["artifact"]["agentRunId"], "run_worker");
        let artifact_id = evidence["artifact"]["artifactId"]
            .as_str()
            .unwrap()
            .to_string();

        // Another Run cannot submit under the worker's claim.
        let error = invoke(
            &mut database,
            &caller(&camp_id, "agent_1", "run_lead", "cmd_steal"),
            LOOM_SUBMIT_TOOL_NAME,
            json!({"taskId": "t1", "evidenceIds": [artifact_id]}),
        )
        .unwrap_err();
        assert_eq!(code(error), "loom.claim_absent");

        let submit = caller(&camp_id, "agent_2", "run_worker", "cmd_submit");
        let candidate = invoke(
            &mut database,
            &submit,
            LOOM_SUBMIT_TOOL_NAME,
            json!({"taskId": "t1", "evidenceIds": [artifact_id]}),
        )
        .unwrap();
        assert_eq!(
            candidate["acceptanceStatus"], "pending",
            "submitting never accepts"
        );
        assert_eq!(
            candidate["acceptanceCriteriaVersion"],
            DEFAULT_ACCEPTANCE_CRITERIA_VERSION
        );
        assert!(
            candidate["contentHash"]
                .as_str()
                .unwrap()
                .starts_with("sha256:")
        );
        // A retry of the same tool call after the Task moved to review replays, not fails.
        let again = invoke(
            &mut database,
            &submit,
            LOOM_SUBMIT_TOOL_NAME,
            json!({"taskId": "t1", "evidenceIds": [artifact_id]}),
        )
        .unwrap();
        assert_eq!(again["candidateId"], candidate["candidateId"]);
        assert_eq!(again["replayed"], true);

        let status = invoke(
            &mut database,
            &caller(&camp_id, "agent_2", "run_worker", "cmd_status"),
            LOOM_STATUS_TOOL_NAME,
            json!({}),
        )
        .unwrap();
        assert_eq!(status["missionId"], mission_id.as_str());
        assert_eq!(status["tasks"].as_array().unwrap().len(), 2);

        // The reviewer's read: the latest candidate, its manifest and the authorization that
        // governs it. No policy exists yet, so the review fields stay null.
        let visible = caller(&camp_id, "agent_2", "run_reviewer", "cmd_inspect");
        let inspected = invoke(
            &mut database,
            &visible,
            LOOM_INSPECT_TOOL_NAME,
            json!({"taskId": "t1"}),
        )
        .unwrap();
        assert_eq!(
            inspected["candidate"]["candidateId"],
            candidate["candidateId"],
            "inspect shows the latest candidate of the task"
        );
        assert_eq!(inspected["task"]["taskId"], "t1");
        assert_eq!(inspected["policyRevision"], Value::Null);
        assert_eq!(inspected["reviewerAgentId"], Value::Null);
        assert_eq!(
            inspected["manifestHash"].as_str().unwrap().len(),
            64,
            "the manifest is a bare sha256 digest the reviewer can pass back"
        );
        assert_eq!(inspected["stageReviews"], json!([]), "no stage review yet");
        assert_eq!(
            inspected["artifacts"].as_array().unwrap().len(),
            1,
            "only the candidate's own evidence is listed"
        );
        assert_eq!(inspected["artifacts"][0]["artifactId"], json!(artifact_id));
        // The same read carries the shape this reviewer has to submit. It is the closed
        // catalog's own schema rather than a second copy, and it fills in only facts this
        // response already read: no verdict and no criterion result is ever suggested.
        let submission = &inspected["reviewSubmission"];
        assert_eq!(submission["tool"], json!(LOOM_STAGE_REVIEW_TOOL_NAME));
        assert_eq!(
            submission["cli"],
            json!("rovai loom stage-review --input-file review.json")
        );
        assert_eq!(submission["prefilled"]["taskId"], json!("t1"));
        assert_eq!(
            submission["prefilled"]["candidateId"],
            candidate["candidateId"]
        );
        assert_eq!(
            submission["prefilled"]["manifestHash"],
            inspected["manifestHash"]
        );
        assert_eq!(
            submission["prefilled"]["policyRevision"],
            Value::Null,
            "no approved policy exists yet, so no revision may be echoed"
        );
        assert_eq!(submission["criterionIds"], json!(["c1"]));
        let canonical = crate::team_tool_catalog::builtin_tool_definitions()
            .iter()
            .find(|definition| {
                definition.get("name").and_then(Value::as_str)
                    == Some(LOOM_STAGE_REVIEW_TOOL_NAME)
            })
            .expect("the catalog must still define the stage review tool")["inputSchema"]
            .clone();
        assert_eq!(
            submission["inputSchema"], canonical,
            "the guidance must be the catalog's own schema, never a copy of it"
        );
        assert_eq!(submission["required"], canonical["required"]);
        // What the response hands over is exactly what the tool deserializes and validates.
        // `policyRevision` is 1 here only because this fixture has no approval to echo; a real
        // reviewer copies the value the response returned.
        let filled = json!({
            "taskId": submission["prefilled"]["taskId"],
            "candidateId": submission["prefilled"]["candidateId"],
            "policyRevision": 1,
            "manifestHash": submission["prefilled"]["manifestHash"],
            "verdict": "request_changes",
            "reason": "the recorded artifact does not answer the criterion",
            "criteriaResults": submission["criterionIds"]
                .as_array()
                .unwrap()
                .iter()
                .map(|criterion_id| json!({"criterionId": criterion_id, "satisfied": false}))
                .collect::<Vec<_>>(),
        });
        serde_json::from_value::<LoomStageReviewToolInput>(filled.clone())
            .expect("the emitted submission shape must deserialize into the tool's own input");
        validate_input(LOOM_STAGE_REVIEW_TOOL_NAME, &filled)
            .expect("the emitted submission shape must pass closed validation");
        // A guessed field name stays refused: `satisfied` has no alias.
        let mut guessed = filled.clone();
        guessed["criteriaResults"][0] = json!({"criterionId": "c1", "passed": false});
        assert!(
            serde_json::from_value::<LoomStageReviewToolInput>(guessed.clone()).is_err(),
            "`passed` is not a criterion result and cannot stand in for `satisfied`"
        );
        assert!(
            validate_input(LOOM_STAGE_REVIEW_TOOL_NAME, &guessed).is_err(),
            "the closed schema still refuses a guessed criterion result"
        );
        // Reading is not a write: the same Run may inspect twice with different command ids.
        invoke(
            &mut database,
            &caller(&camp_id, "agent_2", "run_reviewer", "cmd_inspect_again"),
            LOOM_INSPECT_TOOL_NAME,
            json!({"taskId": "t1"}),
        )
        .unwrap();
        // Another Mission's task id is not readable from here, even though the id exists.
        let error = invoke(
            &mut database,
            &caller(&other_camp, "agent_2", "run_other", "cmd_inspect_other"),
            LOOM_INSPECT_TOOL_NAME,
            json!({"taskId": "t1"}),
        )
        .unwrap_err();
        assert_eq!(code(error), "loom.task_not_found");
    }

    #[test]
    fn domain_codes_become_agent_codes() {
        assert_eq!(agent_error_code("LOOM_PLAN_EXISTS"), "loom.plan_exists");
        assert_eq!(agent_error_code("LOOM_CLAIM_ABSENT"), "loom.claim_absent");
    }

    #[test]
    fn closed_inputs_refuse_injected_identity() {
        for (name, input) in [
            (LOOM_STATUS_TOOL_NAME, json!({"missionId": "m"})),
            (
                LOOM_RELEASE_TOOL_NAME,
                json!({"taskId": "t", "missionId": "m"}),
            ),
            (
                LOOM_CLAIM_TOOL_NAME,
                json!({"taskId": "t", "agentRunId": "r"}),
            ),
            (
                LOOM_CLAIM_TOOL_NAME,
                json!({"taskId": "t", "commandId": "c"}),
            ),
            (
                LOOM_EVIDENCE_TOOL_NAME,
                json!({"relativePath": "a", "agentRunId": "r"}),
            ),
            (
                LOOM_SUBMIT_TOOL_NAME,
                json!({"taskId": "t", "evidenceIds": [], "fenceGeneration": 9}),
            ),
            (
                LOOM_SUBMIT_TOOL_NAME,
                json!({"taskId": "t", "evidenceIds": [], "contentHash": "x"}),
            ),
            (
                LOOM_INSPECT_TOOL_NAME,
                json!({"taskId": "t", "missionId": "m"}),
            ),
            (
                LOOM_STAGE_REVIEW_TOOL_NAME,
                json!({"taskId": "t", "candidateId": "c", "policyRevision": 1,
                    "manifestHash": "h", "verdict": "pass", "reason": "r",
                    "criteriaResults": [{"criterionId": "c1", "satisfied": true}],
                    "reviewerAgentId": "agent_2"}),
            ),
            (
                LOOM_STAGE_REVIEW_TOOL_NAME,
                json!({"taskId": "t", "candidateId": "c", "policyRevision": 1,
                    "manifestHash": "h", "verdict": "pass", "reason": "r",
                    "criteriaResults": [{"criterionId": "c1", "satisfied": true}],
                    "commandId": "forged"}),
            ),
        ] {
            let error = validate_input(name, &input).unwrap_err();
            assert_eq!(
                error.downcast_ref::<LoomToolError>().unwrap().code(),
                "loom.invalid_input",
                "{name} {input}"
            );
        }
        validate_input(LOOM_STATUS_TOOL_NAME, &json!({})).unwrap();
        validate_input(
            LOOM_SUBMIT_TOOL_NAME,
            &json!({"taskId": "t", "evidenceIds": ["a"]}),
        )
        .unwrap();
        // Both new tools are admitted by name only; the reviewer identity is never an input.
        validate_input(LOOM_INSPECT_TOOL_NAME, &json!({"taskId": "t"})).unwrap();
        validate_input(
            LOOM_STAGE_REVIEW_TOOL_NAME,
            &json!({
                "taskId": "t",
                "candidateId": "c",
                "policyRevision": 1,
                "manifestHash": "0".repeat(64),
                "verdict": "pass",
                "reason": "matches every criterion",
                "criteriaResults": [{"criterionId": "c1", "satisfied": true}]
            }),
        )
        .unwrap();
    }

    /// Bytes packaged as `skills/cli-operations/references/loom.md`.
    const LOOM_REFERENCE: &str = include_str!("../../../skills/cli-operations/references/loom.md");

    const PLAN_FILE_SHAPE: &str = r#"Plan file shape (`rovai loom plan --input-file plan.json`). Every object has exactly these fields; leave an optional field out instead of sending `null`, and add no other fields:

```json
{
  "goal": "Write a short project report",
  "criteria": [
    { "criterionId": "report-exists", "text": "out/report.md exists and covers the three points" }
  ],
  "tasks": [
    { "taskId": "report-draft", "title": "Draft the report", "description": "Write out/report.md" },
    { "taskId": "report-review", "title": "Review the report" }
  ],
  "dependencies": [
    { "upstreamTaskId": "report-draft", "downstreamTaskId": "report-review", "condition": "task_done" }
  ]
}
```

Optional: `acceptanceCriteriaVersion` (top level), `description` and `assigneeAgentId` (per task), `condition` (per dependency, `task_done` or `artifact_accepted`, lowercase), `dependencies` itself."#;

    fn reference_plan_example(reference: &str) -> Value {
        let plan = reference
            .split_once("## Plan")
            .expect("Plan section")
            .1
            .split_once("## Deliver")
            .expect("Deliver follows Plan")
            .0;
        assert!(
            plan.contains(PLAN_FILE_SHAPE),
            "the Plan section must end with the confirmed file shape"
        );
        let marker = "```json\n";
        let start = plan
            .find(marker)
            .expect("the Plan section has one JSON example");
        assert_eq!(plan.matches(marker).count(), 1);
        let body = &plan[start + marker.len()..];
        let end = body.find("\n```").expect("the JSON example is fenced");
        serde_json::from_str(&body[..end]).expect("the plan example is JSON")
    }

    #[test]
    fn reference_plan_example_passes_the_closed_plan_schema_unchanged() {
        let example = reference_plan_example(LOOM_REFERENCE);
        assert_eq!(
            example,
            json!({
                "goal": "Write a short project report",
                "criteria": [
                    {
                        "criterionId": "report-exists",
                        "text": "out/report.md exists and covers the three points"
                    }
                ],
                "tasks": [
                    {
                        "taskId": "report-draft",
                        "title": "Draft the report",
                        "description": "Write out/report.md"
                    },
                    { "taskId": "report-review", "title": "Review the report" }
                ],
                "dependencies": [
                    {
                        "upstreamTaskId": "report-draft",
                        "downstreamTaskId": "report-review",
                        "condition": "task_done"
                    }
                ]
            })
        );
        crate::team_tool_catalog::validate_builtin_tool_input(LOOM_PLAN_TOOL_NAME, &example)
            .unwrap();
        validate_input(LOOM_PLAN_TOOL_NAME, &example).unwrap();

        let mut with_null = example.clone();
        with_null["tasks"][0]["assigneeAgentId"] = Value::Null;
        let mut extra_field = example.clone();
        extra_field["tasks"][0]["notes"] = json!("extra");
        let mut wrong_name = example.clone();
        let text = wrong_name["criteria"][0]["text"].take();
        wrong_name["criteria"][0]["body"] = text;
        let mut uppercase = example.clone();
        uppercase["dependencies"][0]["condition"] = json!("TASK_DONE");
        for invalid in [with_null, extra_field, wrong_name, uppercase] {
            assert!(
                crate::team_tool_catalog::validate_builtin_tool_input(
                    LOOM_PLAN_TOOL_NAME,
                    &invalid
                )
                .is_err(),
                "closed schema still rejects {invalid}"
            );
        }
    }

    /// The review example the packaged reference shows a reviewer must itself be a valid
    /// stage-review submission, or the document would teach a shape Core refuses.
    #[test]
    fn reference_review_example_passes_the_closed_stage_review_schema() {
        let section = LOOM_REFERENCE
            .split_once("## Authorized stage review and handoff")
            .expect("the reference documents the authorized stage review")
            .1;
        let marker = "```json\n";
        let start = section
            .find(marker)
            .expect("the review section has one JSON example");
        assert_eq!(section.matches(marker).count(), 1, "one review example only");
        let body = &section[start + marker.len()..];
        let end = body.find("\n```").expect("the JSON example is fenced");
        let example: Value =
            serde_json::from_str(&body[..end]).expect("the review example is JSON");
        assert_eq!(
            example["criteriaResults"][0]["satisfied"],
            json!(false),
            "a criterion result carries `satisfied`, never a verdict"
        );
        assert!(
            example["criteriaResults"][0].get("passed").is_none(),
            "the documented criterion result has no `passed` field"
        );
        // The documented placeholder hash is replaced with a real digest: the shape check is
        // format-strict about `manifestHash`, and every other field is the document's own text.
        let mut submission = example.clone();
        submission["manifestHash"] = json!("0".repeat(64));
        validate_input(LOOM_STAGE_REVIEW_TOOL_NAME, &submission)
            .expect("the documented review shape must pass closed validation");
        crate::team_tool_catalog::validate_builtin_tool_input(
            LOOM_STAGE_REVIEW_TOOL_NAME,
            &submission,
        )
        .expect("the documented review shape must pass the catalog schema");
        // The document cannot smuggle an alias past the closed schema either.
        let mut guessed = submission.clone();
        guessed["criteriaResults"][0] = json!({"criterionId": "report-exists", "passed": false});
        assert!(
            validate_input(LOOM_STAGE_REVIEW_TOOL_NAME, &guessed).is_err(),
            "`passed` is still refused"
        );
    }
}
