//! One claim snapshot owns both FIFO sizing and later input assembly.
use super::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BootstrapContents {
    pub session_charter: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_guidance: Option<String>,
    pub platform_skills: String,
    pub memory_entrypoint: String,
    pub observed_memory_revisions: Vec<Value>,
    pub authorization_basis_digest: String,
}

impl BootstrapContents {
    pub(super) fn read<R: ContextReadConnection>(
        database: &R,
        data_dir: &std::path::Path,
        snapshot: &RunSnapshot,
    ) -> Result<Self> {
        let connection = database.context_connection();
        let mut session_charter = build_session_charter(
            snapshot,
            camp_has_active_file_delivery_binding(connection, &snapshot.camp_id)?,
            mission_facts(connection, snapshot)?.is_some(),
        )?;
        // Selected user guidance is composed here, once, before the charter is
        // hashed and stored as immutable Bootstrap evidence. Every later replay
        // of this Run therefore reads the same bytes; a later edit to the
        // selection belongs to the next Run.
        if super::run_snapshot_adapter_kind(snapshot).is_ok_and(selected_rules_apply_to) {
            let rules = crate::member_capability::selected_rules(connection, &snapshot.agent_id)?;
            session_charter = compose_selected_rules(session_charter, &rules)?;
        }
        let (memory_entrypoint, observed_memory_revisions, authorization_basis_digest) =
            if snapshot.invocation_kind == "single_chat" {
                (
                    String::new(),
                    Vec::new(),
                    canonical_json_digest(&json!({
                        "schemaVersion": 1, "memoryAccess": "none"
                    }))?,
                )
            } else {
                build_memory_entrypoint(database, snapshot)?
            };
        let managed = crate::managed_skills::ManagedSkills::for_data_dir(data_dir)?;
        managed.sync()?;
        let (entries, omitted) = managed.index(crate::managed_skills::PLATFORM_SKILLS);
        anyhow::ensure!(
            omitted.is_empty(),
            "platform Skill source is unavailable: {}",
            omitted.join("; ")
        );
        Ok(Self {
            team_guidance: if snapshot.invocation_kind == "single_chat" {
                None
            } else {
                crate::teams::thread_guidance(connection, &snapshot.camp_id)?
            },
            session_charter,
            platform_skills: format!(
                "[ROVAI_PLATFORM_SKILLS]\n{}\n[/ROVAI_PLATFORM_SKILLS]",
                managed.index_json(&entries)?
            ),
            memory_entrypoint,
            observed_memory_revisions,
            authorization_basis_digest,
        })
    }

    fn payload(&self, member_identity: &MemberIdentityBootstrapProjection) -> Result<String> {
        render_session_bootstrap(
            &self.session_charter,
            member_identity,
            self.team_guidance.as_deref(),
            Some(&self.platform_skills),
            &self.memory_entrypoint,
        )
    }
}

/// Public-batch manifest versions with a persisted claimed context.
/// PUBLIC_CAMP_BATCH_CONTEXT_MANIFEST_VERSION is 40; the global/single-chat
/// version 42 has a different frozen bootstrap path and is not admitted here.
fn claim_manifest_version_is_current(version: i64) -> bool {
    matches!(version, 36 | 37 | 38 | 39 | 40)
}

/// Only the four product Runtimes receive the selected user guidance.
fn selected_rules_apply_to(adapter: AdapterKind) -> bool {
    matches!(
        adapter,
        AdapterKind::ClaudeCodeCli
            | AdapterKind::CodexCli
            | AdapterKind::DeepseekHarness
            | AdapterKind::Pi
    )
}

const SELECTED_RULES_OPEN: &str = "[SELECTED_ASSISTANT_RULES]";
const SELECTED_RULES_CLOSE: &str = "[/SELECTED_ASSISTANT_RULES]";
const SELECTED_RULES_INTRO: &str = "以下内容是用户为当前助手选择的指引，属于用户层说明：不授予任何权限、不是系统策略、不改变工具授权或沙箱。";
/// Bounded, complete-or-nothing budget for the composed section alone.
const SELECTED_RULES_MAX_BYTES: usize = 64 * 1024;

/// Appends the selected user guidance as an explicit, subordinate section of the
/// per-Run Session Charter. No rules means the original bytes are returned
/// untouched. Over budget is a hard failure: constraints are never silently
/// dropped or truncated.
fn compose_selected_rules(
    charter: String,
    rules: &[crate::member_capability::ProjectedCapability],
) -> Result<String> {
    if rules.is_empty() {
        return Ok(charter);
    }
    let mut segment = String::from(SELECTED_RULES_OPEN);
    segment.push('\n');
    segment.push_str(SELECTED_RULES_INTRO);
    for rule in rules {
        let record = json!({
            "id": rule.id,
            "name": rule.name,
            "body": rule.body,
            "origin": rule.origin,
            "bodyDigest": sha256_text(&rule.body),
        });
        segment.push('\n');
        segment.push_str(&serde_json::to_string(&record)?);
    }
    segment.push('\n');
    segment.push_str(SELECTED_RULES_CLOSE);
    anyhow::ensure!(
        segment.len() <= SELECTED_RULES_MAX_BYTES,
        "selected assistant rules exceed {SELECTED_RULES_MAX_BYTES} bytes; narrow the selection before this Run"
    );
    let mut composed = charter;
    composed.push_str("\n\n");
    composed.push_str(&segment);
    Ok(composed)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaimedBatchContext {
    pub(super) bootstrap: BootstrapContents,
    pub(super) member_identity: MemberIdentityBootstrapProjection,
    #[serde(flatten)]
    pub(super) dynamic: input::DynamicInputContext,
    pub(super) run_input: Value,
    bootstrap_reserve: usize,
}

impl ClaimedBatchContext {
    pub(super) fn available_run_input(
        input: &Value,
        links: &[crate::current_input_skill::CurrentInputSkillLink],
    ) -> Value {
        let mut input = input.clone();
        if let Some(messages) = input.get_mut("messages").and_then(Value::as_array_mut) {
            for (index, message) in messages.iter_mut().enumerate() {
                if let Some(skills) = message.get_mut("skills").and_then(Value::as_array_mut) {
                    skills.retain(|skill| {
                        links.iter().any(|link| {
                            // v2 links are deduplicated by source ID. Their index/name
                            // describe the first mention; later messages retain their alias.
                            skill["path"].as_str() == Some(link.path.as_str())
                                && (link.skill_id.is_some()
                                    || (link
                                        .message_index
                                        .is_none_or(|message_index| message_index == index)
                                        && skill["name"].as_str() == Some(link.name.as_str())))
                        })
                    });
                    if skills.is_empty() {
                        message
                            .as_object_mut()
                            .expect("message projection is an object")
                            .remove("skills");
                    }
                }
            }
        }
        input
    }

    pub(crate) fn prepare(
        transaction: &Transaction<'_>,
        request: &DeliveryContextPreview<'_>,
        workspace_fact: Option<&Value>,
    ) -> Result<Self> {
        let snapshot = prospective_delivery_snapshot(transaction, request)?;
        let data_dir = std::path::Path::new(
            transaction
                .path()
                .context("Core database path is unavailable")?,
        )
        .parent()
        .context("Core data directory is unavailable")?;
        let bootstrap = BootstrapContents::read(transaction, data_dir, &snapshot)?;
        let member_identity = load_latest_member_identity(transaction, &snapshot.agent_id)?;
        let adapter = run_snapshot_adapter_kind(&snapshot)?;
        let may_redeliver = crate::compaction::release_default_policy(adapter)
            == crate::compaction::CompactionDetectorPolicy::BestEffort
            || has_pending_bootstrap_redelivery(transaction, &snapshot)?;
        // A resumed Session may need a new Bootstrap or be replaced after claim.
        // Reserve actual frozen bytes, never zero merely because an old digest exists.
        let bootstrap_reserve = if adapter == AdapterKind::HermesCli {
            hermes_rules::envelope("update", &bootstrap.payload(&member_identity)?).len() + 2
        } else if request.charter_delivery_mode == CharterDeliveryMode::FirstPayload
            || may_redeliver
        {
            render_bootstrap_redelivery_overlay(&bootstrap.payload(&member_identity)?).len() + 2
        } else {
            0
        };
        Ok(Self {
            bootstrap,
            member_identity,
            dynamic: input::DynamicInputContext::prepare(transaction, &snapshot, workspace_fact)?,
            run_input: json!({"messages": []}),
            bootstrap_reserve,
        })
    }

    pub(crate) fn with_input(
        &self,
        transaction: &Transaction<'_>,
        request: &DeliveryContextPreview<'_>,
        run_input: Value,
        skills: &SkillSelectionSnapshot,
        previous_boundary: i64,
        additional_messages: bool,
        continuation_input: bool,
    ) -> Result<Self> {
        let mut selected = self.clone();
        let mut snapshot = prospective_delivery_snapshot(transaction, request)?;
        snapshot.skill_selection_snapshot = skills.clone();
        selected.additional_skills = prepare_additional_skills(
            transaction,
            std::path::Path::new(
                transaction
                    .path()
                    .context("Core database path is unavailable")?,
            )
            .parent()
            .context("Core data directory is unavailable")?,
            &snapshot,
        )?;
        selected.run_input = run_input;
        let mut facts: Value = serde_json::from_str(&selected.run_facts.payload_json)?;
        facts["historyHint"] = json!(public_history_hint(previous_boundary, additional_messages));
        if continuation_input {
            facts["retry"] = json!({
                "requiredAction": "check_existing_results_before_repeating_external_effects",
                "instruction": "先检查已有成果，不重复外部操作。",
            });
        }
        selected.run_facts.payload_json = serde_json::to_string(&facts)?;
        selected.run_facts.references.push(RunFactRef {
            fact: "history_hint".into(),
            task_id: None,
            mission_id: None,
        });
        if continuation_input
            && !selected
                .run_facts
                .references
                .iter()
                .any(|reference| reference.fact == "retry")
        {
            selected.run_facts.references.push(RunFactRef {
                fact: "retry".into(),
                task_id: None,
                mission_id: None,
            });
        }
        while selected.payload_len()? > request.max_payload_bytes && !selected.tasks.is_empty() {
            selected.tasks.pop();
            selected.omitted_tasks += 1;
        }
        Ok(selected)
    }

    pub(crate) fn payload_len(&self) -> Result<usize> {
        let tasks = self
            .tasks_enabled
            .then(|| self_active_task_projection(&self.tasks, self.omitted_tasks))
            .flatten();
        let facts = self.run_facts_for_session(true)?;
        let payload = render_payload(RenderPayloadInput {
            collaboration_state: Some(&self.collaboration_state),
            self_active_tasks: tasks.as_ref(),
            shared_conversation: None,
            run_facts: &facts,
            workspace: self.workspace.value.as_ref(),
            additional_skills: Some(&self.additional_skills.section),
            a2a_guidance: None,
            single_chat_guidance: None,
            current_input: None,
            run_input: Some(&self.run_input),
        })?;
        Ok(payload.len().saturating_add(self.bootstrap_reserve))
    }

    pub(crate) fn persist(&self, transaction: &Transaction<'_>, run_id: &str) -> Result<()> {
        // The final selection publishes its private Skill bytes only now, after the
        // Run exists. Every candidate prefix kept its bytes in memory and dropped
        // them, so a superseded selection never owns a directory.
        if let Some(pending) = self.additional_skills.pending.as_ref() {
            let data_dir = std::path::Path::new(
                transaction
                    .path()
                    .context("Core database path is unavailable")?,
            )
            .parent()
            .context("Core data directory is unavailable")?;
            pending.publish(data_dir)?;
        }
        transaction.execute(
            "INSERT INTO agent_run_claim_context(agent_run_id, context_json) VALUES (?1, ?2)",
            params![run_id, serde_json::to_string(self)?],
        )?;
        Ok(())
    }
}

pub(super) fn load(connection: &Connection, run_id: &str) -> Result<Option<ClaimedBatchContext>> {
    // Historical inputs retain their original materializer, including databases
    // exercised at intermediate migration boundaries. Only the versions this
    // build actually writes are replayable from the claim; an unknown future
    // version is never accepted here.
    let version: Option<i64> = connection
        .query_row(
            "SELECT context_manifest_version FROM agent_run_input WHERE agent_run_id=?1",
            [run_id],
            |row| row.get::<_, Option<i64>>(0),
        )
        .optional()?
        .flatten();
    if !version.is_some_and(claim_manifest_version_is_current) {
        return Ok(None);
    }
    let json: Option<String> = connection
        .query_row(
            "SELECT context_json FROM agent_run_claim_context WHERE agent_run_id=?1",
            [run_id],
            |row| row.get(0),
        )
        .optional()?;
    let json = json.context("Public batch is missing its claimed context")?;
    Ok(Some(
        serde_json::from_str(&json).context("Invalid claimed batch context")?,
    ))
}

impl std::ops::Deref for ClaimedBatchContext {
    type Target = input::DynamicInputContext;
    fn deref(&self) -> &Self::Target {
        &self.dynamic
    }
}
impl std::ops::DerefMut for ClaimedBatchContext {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.dynamic
    }
}

/// Only startup contents of an actual Single Chat Run are captured here. This
/// is not a Public Batch/DynamicInputContext and never widens private-chat tools.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct FrozenSingleChatBootstrap {
    version: u32,
    agent_run_id: String,
    agent_id: String,
    camp_id: String,
    conversation_id: String,
    pub(super) bootstrap: BootstrapContents,
    pub(super) member_identity: MemberIdentityBootstrapProjection,
}

impl FrozenSingleChatBootstrap {
    pub(super) fn capture(
        transaction: &Transaction<'_>,
        data_dir: &std::path::Path,
        agent_run_id: &str,
    ) -> Result<String> {
        let snapshot = load_queued_run_snapshot(transaction, agent_run_id)?
            .context("remote_single_chat_real_queued_run_required")?;
        anyhow::ensure!(
            snapshot.invocation_kind == "single_chat" && snapshot.execution_epoch == 0,
            "remote_single_chat_bootstrap_scope"
        );
        let value = Self {
            version: 1,
            agent_run_id: snapshot.agent_run_id.clone(),
            agent_id: snapshot.agent_id.clone(),
            camp_id: snapshot.camp_id.clone(),
            conversation_id: snapshot.conversation_id.clone(),
            bootstrap: BootstrapContents::read(transaction, data_dir, &snapshot)?,
            member_identity: load_latest_member_identity(transaction, &snapshot.agent_id)?,
        };
        value.validate(&snapshot)?;
        let json = serde_json::to_string(&value)?;
        anyhow::ensure!(
            json.len() <= 1024 * 1024,
            "remote_single_chat_bootstrap_size"
        );
        Ok(json)
    }

    pub(super) fn load(connection: &Connection, snapshot: &RunSnapshot) -> Result<Option<Self>> {
        if snapshot.invocation_kind != "single_chat"
            || !crate::remote_execution::authority_table_available(
                connection,
                "agent_run_execution_target",
            )?
        {
            return Ok(None);
        }
        let Some(target) =
            crate::remote_execution::load_run_target(connection, &snapshot.agent_run_id)?
        else {
            return Ok(None);
        };
        anyhow::ensure!(
            target.member_id == snapshot.agent_id
                && target.conversation_id == snapshot.conversation_id
                && target.camp_id == snapshot.camp_id,
            "remote_single_chat_bootstrap_scope"
        );
        let json: Option<String> = connection.query_row(
            "SELECT session_bootstrap_json FROM agent_run_remote_bundle_source WHERE agent_run_id=?1",
            [&snapshot.agent_run_id], |row| row.get::<_, Option<String>>(0),
        ).optional()?.flatten();
        let json = json.context("remote_single_chat_bootstrap_required")?;
        anyhow::ensure!(
            json.len() <= 1024 * 1024,
            "remote_single_chat_bootstrap_size"
        );
        let value: Self =
            serde_json::from_str(&json).context("remote_single_chat_bootstrap_invalid")?;
        value.validate(snapshot)?;
        Ok(Some(value))
    }

    fn validate(&self, snapshot: &RunSnapshot) -> Result<()> {
        anyhow::ensure!(
            self.version == 1
                && self.agent_run_id == snapshot.agent_run_id
                && self.agent_id == snapshot.agent_id
                && self.camp_id == snapshot.camp_id
                && self.conversation_id == snapshot.conversation_id
                && self.bootstrap.team_guidance.is_none()
                && self.bootstrap.memory_entrypoint.is_empty()
                && self.bootstrap.observed_memory_revisions.is_empty()
                && self.bootstrap.authorization_basis_digest
                    == canonical_json_digest(&json!({"schemaVersion":1,"memoryAccess":"none"}))?,
            "remote_single_chat_bootstrap_scope"
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::member_capability::ProjectedCapability;

    fn rule(id: &str, name: &str, body: &str, origin: &str) -> ProjectedCapability {
        ProjectedCapability {
            id: id.to_string(),
            name: name.to_string(),
            body: body.to_string(),
            origin: origin.to_string(),
        }
    }

    fn build_fixture_charter() -> String {
        "[SESSION_CHARTER]\nfixture\n[/SESSION_CHARTER]\n- channel guidance".to_string()
    }

    fn records(composed: &str) -> Vec<Value> {
        composed
            .lines()
            .filter(|line| line.starts_with('{'))
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect()
    }

    #[test]
    fn no_selected_rules_returns_the_existing_charter_bytes() {
        let charter = build_fixture_charter();
        let composed = compose_selected_rules(charter.clone(), &[]).unwrap();
        assert_eq!(composed, charter, "a Run without selected rules stays byte-identical");
    }

    #[test]
    fn selected_rules_are_ordered_escaped_and_carry_no_authority() {
        let rules = vec![
            rule("rule_b", "乙规则", "不要提交密钥。", "explicit"),
            rule("rule_a", "甲规则", "换行\n与[/SELECTED_ASSISTANT_RULES]标记不能越出本条", "inherited"),
        ];
        let composed = compose_selected_rules(build_fixture_charter(), &rules).unwrap();
        // Markers stay their own lines: a body quoting the marker is JSON-escaped
        // inside a single record line and can never open or close the section.
        assert_eq!(
            composed.lines().filter(|line| *line == SELECTED_RULES_OPEN).count(),
            1
        );
        assert_eq!(
            composed.lines().filter(|line| *line == SELECTED_RULES_CLOSE).count(),
            1
        );
        assert_eq!(composed.lines().filter(|line| line.starts_with('{')).count(), 2);
        let records = records(&composed);
        assert_eq!(records.len(), 2);
        assert_eq!(records[0]["id"], json!("rule_b"));
        assert_eq!(records[1]["id"], json!("rule_a"));
        for record in &records {
            let mut keys = record.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
            keys.sort();
            assert_eq!(
                keys,
                ["body", "bodyDigest", "id", "name", "origin"],
                "a rule row never carries a permission, sandbox or authority field"
            );
            assert_eq!(
                record["bodyDigest"],
                json!(sha256_text(record["body"].as_str().unwrap()))
            );
        }
        assert!(composed.ends_with(SELECTED_RULES_CLOSE));
        assert!(composed.contains("以下内容是用户为当前助手选择的指引"));
    }

    #[test]
    fn oversized_selected_rules_fail_closed() {
        let rules = vec![rule("rule_big", "超大规则", &"约".repeat(SELECTED_RULES_MAX_BYTES), "explicit")];
        let error = compose_selected_rules(build_fixture_charter(), &rules)
            .unwrap_err()
            .to_string();
        assert!(error.contains("selected assistant rules exceed"), "{error}");
    }

    #[test]
    fn claim_manifest_versions_cover_current_builds_only() {
        for version in 36..=40 {
            assert!(claim_manifest_version_is_current(version), "{version}");
        }
        for version in [0, 1, 35, 41, 42, 43, 99] {
            assert!(!claim_manifest_version_is_current(version), "{version}");
        }
    }
}
