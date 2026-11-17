//! Current catalog/source capture. This is the trusted A-side seam; the pure
//! builder never reads the database, filesystem, environment or preview JSON.
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    path::Path,
};

use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::{
    RunBundleBuildRequest, SkillFileSource, build_remote_run_bundle, validate_mcp_servers,
};
use crate::{
    agent_profile::{AdapterKind, AgentProfileService},
    context,
    db::Database,
    managed_skills::{ManagedSkills, PLATFORM_SKILLS, SkillIndexEntry, TOOLBOX_SKILLS},
    mcp::{McpConfigStore, McpServerDefinition},
    mcp_projection::{McpProjectionRequest, materialize_member_servers},
};
use loom_protocol::run_bundle::{
    MAX_BUNDLE_DECODED_BYTES, MAX_BUNDLE_FILE_BYTES, MAX_BUNDLE_FILES, RunBundleV1,
    safe_bundle_relative,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FreezeMemberBundleParams {
    pub member_id: String,
    pub runtime: String,
    #[serde(default)]
    pub reported_runtime_version: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FrozenMemberBundle {
    pub bundle: RunBundleV1,
    pub manifest: Value,
}

#[derive(Debug)]
pub(crate) struct BundleSourceError {
    code: &'static str,
    item: String,
}
impl BundleSourceError {
    pub(crate) fn code(&self) -> &'static str {
        self.code
    }
    fn error(code: &'static str, item: &str) -> anyhow::Error {
        anyhow::Error::new(Self {
            code,
            item: item.to_string(),
        })
    }
}
impl std::fmt::Display for BundleSourceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.item)
    }
}
impl std::error::Error for BundleSourceError {}

pub(crate) fn capture_member_bundle_source(
    database: &Database,
    data_dir: &Path,
    store: &McpConfigStore,
    params: &FreezeMemberBundleParams,
) -> Result<CapturedMemberBundleSource> {
    let stamp = BundleSourceDatabaseStamp::capture(database.connection())?;
    let tx = database.connection().unchecked_transaction()?;
    let source = capture_in_existing_transaction(database, data_dir, store, params)?;
    tx.rollback()?;
    // Standalone callers still fence the gap before their later write transaction.
    stamp.verify(database.connection())?;
    Ok(CapturedMemberBundleSource { stamp, source })
}

/// Capture under the scheduler's existing transaction, so target selection,
/// capability bytes and the real AgentRun can be committed atomically. This
/// helper owns no transaction boundary and performs no database writes.
pub(crate) fn capture_in_existing_transaction(
    database: &Database,
    data_dir: &Path,
    store: &McpConfigStore,
    params: &FreezeMemberBundleParams,
) -> Result<FrozenBundleSource> {
    ensure!(
        !database.connection().is_autocommit(),
        "bundle_source_transaction_required"
    );
    let adapter = match params.runtime.as_str() {
        "codex-cli" => AdapterKind::CodexCli,
        "claude-code" | "claude-code-cli" => AdapterKind::ClaudeCodeCli,
        _ => {
            return Err(BundleSourceError::error(
                "bundle_runtime_unsupported",
                "runtime",
            ));
        }
    };
    // The caller's transaction keeps body/choice/profile rows in one snapshot.
    // External MCP replacement is checked by its digest before and after capture.
    let profile = AgentProfileService::default()
        .get_profile(database, &params.member_id)?
        .ok_or_else(|| BundleSourceError::error("bundle_member_not_found", "member"))?;
    let parts =
        context::member_projection_bootstrap(database, data_dir, &profile.agent_id, adapter)?;
    let bootstrap = context::render_session_bootstrap(
        &parts.charter,
        &parts.identity,
        parts.team_guidance.as_deref(),
        parts.platform_skills.as_deref(),
        &parts.memory_entrypoint,
    )?;
    let known = AgentProfileService::default().all_profile_ids(database)?;
    let catalog = crate::member_capability::get_member_capability_catalog(
        database,
        store,
        &profile.agent_id,
    )?;
    let (_projected_skills, rules, hooks) =
        crate::member_capability::projection_additions(database, store, &profile.agent_id)?;
    let hook_reviews = crate::member_capability::frozen_hook_reviews(
        database, store, &profile.agent_id,
    )?;
    crate::member_capability::validate_frozen_hook_reviews(&hook_reviews, &hooks)?;
    let (mcp_view, raw) = store.get_with_raw_readonly(&known)?;
    if mcp_view.file_issue.is_some() {
        return Err(BundleSourceError::error("bundle_mcp_source_invalid", "mcp"));
    }
    let selected_mcp = catalog
        .items
        .iter()
        .filter(|item| item.kind == "mcp" && item.selected)
        .map(|item| (item.name.clone(), item.id.clone()))
        .collect::<BTreeMap<_, _>>();
    let mut servers = BTreeMap::new();
    for (name, id) in &selected_mcp {
        let raw = raw
            .as_ref()
            .ok_or_else(|| BundleSourceError::error("bundle_selected_mcp_unavailable", name))?;
        let metadata = raw
            .rovai
            .servers
            .get(name)
            .ok_or_else(|| BundleSourceError::error("bundle_selected_mcp_unavailable", name))?;
        if !metadata.enabled
            || metadata.server_id != *id
            || !raw.rovai.assignments.iter().any(|assignment| {
                assignment.server_id == *id && assignment.agent_id == profile.agent_id
            })
        {
            return Err(BundleSourceError::error(
                "bundle_selected_mcp_unavailable",
                name,
            ));
        }
        let mut definition = raw
            .mcp_servers
            .get(name)
            .cloned()
            .ok_or_else(|| BundleSourceError::error("bundle_selected_mcp_unavailable", name))?;
        if let McpServerDefinition::Stdio { cwd, .. } = &mut definition {
            // No A absolute path is meaningful on B. The initial portable
            // contract supports only inheritance from the chosen node workspace.
            if cwd.as_deref().is_some_and(|value| value != ".") {
                return Err(BundleSourceError::error(
                    "bundle_mcp_cwd_not_portable",
                    name,
                ));
            }
            *cwd = None;
        }
        servers.insert(name.clone(), definition);
    }
    // Refuse credentials before invoking the existing projector, so it cannot
    // interpolate A's environment into an exported packet.
    validate_mcp_servers(&servers)?;
    let reference_servers = super::selected_mcp_has_references(&servers);
    if reference_servers {
        // The projector resolves A's own environment, so it must not see a
        // reference at all: a missing A value would silently drop the server.
        // Only the pure capability check applies here; the value is resolved on
        // the node.
        qualify_reference_servers(&servers, adapter, params.reported_runtime_version.as_deref())?;
    } else {
        let projected = materialize_member_servers(
            store,
            &McpProjectionRequest {
                agent_run_id: "run_snapshot",
                execution_epoch: 1,
                agent_id: &profile.agent_id,
                adapter_kind: adapter,
                reported_runtime_version: params.reported_runtime_version.as_deref(),
                execution_root: data_dir,
            },
            false,
        )?;
        for name in servers.keys() {
            if !projected.contains_key(name) {
                return Err(BundleSourceError::error(
                    "bundle_selected_mcp_unavailable",
                    name,
                ));
            }
        }
    }

    let managed = ManagedSkills::for_data_dir(data_dir)?;
    // Only fixed toolbox names come from the catalog; a registered Library Skill
    // is a `library:` choice of its own and its bytes come from the helper.
    let optional_names = catalog
        .items
        .iter()
        .filter(|item| {
            item.kind == "skill"
                && item.selected
                && !item.id.starts_with(crate::member_capability::SKILL_SOURCE_ID_PREFIX)
        })
        .map(|item| item.name.as_str())
        .collect::<BTreeSet<_>>();
    if optional_names
        .iter()
        .any(|name| !TOOLBOX_SKILLS.contains(name))
    {
        return Err(BundleSourceError::error(
            "bundle_skill_source_unavailable",
            "skill",
        ));
    }
    let imported: Vec<crate::member_capability::SelectedSource> =
        crate::member_capability::selected_library_sources(database.connection(), &profile.agent_id)?;
    // Platform, toolbox and imported Skills share one `skills/<name>/` root, so a
    // case-insensitive clash would silently overwrite one Run's source.
    let mut frozen_names = BTreeSet::new();
    for name in PLATFORM_SKILLS
        .into_iter()
        .chain(optional_names.iter().copied())
        .chain(imported.iter().map(|source| source.name.as_str()))
    {
        if !frozen_names.insert(name.to_lowercase()) {
            return Err(BundleSourceError::error("bundle_skill_name_conflict", name));
        }
    }
    let (mut skill_index, omissions) = managed.index(optional_names.iter().copied());
    let (platform_skill_index, platform_omissions) = managed.index(PLATFORM_SKILLS);
    if !omissions.is_empty() || !platform_omissions.is_empty() {
        return Err(BundleSourceError::error(
            "bundle_skill_source_unavailable",
            "skill",
        ));
    }
    // Imported entries append their real Skill name and description to the same
    // index; the index root stays the managed root (relocated on B), never an
    // A-side Library path.
    for source in &imported {
        skill_index.push(SkillIndexEntry {
            name: source.name.clone(),
            desc: source.description.clone(),
        });
    }
    let source_skill_root = dunce::simplified(managed.root())
        .to_str()
        .ok_or_else(|| BundleSourceError::error("bundle_skill_source_unavailable", "root"))?
        .to_string();
    let mut files = Vec::new();
    let mut total = 0usize;
    let mut assets = Vec::new();
    for name in PLATFORM_SKILLS
        .into_iter()
        .chain(optional_names.iter().copied())
    {
        let mandatory = PLATFORM_SKILLS.contains(&name);
        let directory = managed.root().join(name);
        collect_skill_files(&directory, &directory, name, &mut files, &mut total)?;
        assets.push(json!({
            "kind":"skill", "id":name, "mandatory":mandatory,
            "source":"managed-published-skill",
            "reason": if mandatory {"existing-bootstrap-platform-index"} else {"member-selection"},
            "digest":frozen_skill_digest(&files, name)
        }));
    }
    // Imported sources were admitted and verified before the copy; the same
    // registered revision is re-verified afterwards below.
    for source in &imported {
        collect_skill_files(&source.path, &source.path, &source.name, &mut files, &mut total)?;
        assets.push(json!({
            "kind":"skill", "id":source.id, "mandatory":false,
            "source":"managed-skill-library",
            "reason":"member-selection",
            "revision":source.revision_id,
            "contentDigest":source.content_digest,
            "digest":frozen_skill_digest(&files, &source.name)
        }));
    }
    // Neither the current revision nor the source bytes may move during a read:
    // a changed revision is a new source, never a mixed Run snapshot.
    for source in &imported {
        crate::member_capability::verify_selected_skill_source(database.connection(), source)?;
    }
    for item in catalog
        .items
        .iter()
        .filter(|item| item.selected && item.kind != "skill")
    {
        assets.push(json!({
            "kind":item.kind, "id":item.id, "mandatory":false,
            "source":item.source, "reason":"member-selection"
        }));
    }
    let (after, _) = store.get_with_raw_readonly(&known)?;
    if after.config_digest != mcp_view.config_digest {
        return Err(BundleSourceError::error("bundle_source_changed", "mcp"));
    }
    let credential_policy = if reference_servers {
        "references-only"
    } else {
        "key-free-literals-only"
    };
    let mut manifest = json!({
        "schemaVersion":1, "selectionRevision":catalog.revision,
        "mcpSourceDigest":mcp_view.config_digest, "assets":assets,
        "optionalAssetScope":"rovai-member-selection",
        "nativeHostConfiguration":"independent",
        "credentialPolicy":credential_policy
    });
    // No-hook snapshots keep their existing shape and digest inputs.
    if !hook_reviews.is_empty() {
        manifest["hookReviews"] = serde_json::to_value(hook_reviews)?;
    }
    Ok(FrozenBundleSource {
        version: 1,
        member_id: profile.agent_id,
        adapter,
        selection_revision: catalog.revision.clone(),
        source_skill_root,
        default_bootstrap: bootstrap,
        files,
        skill_index,
        platform_skill_index,
        servers,
        mcp_ids: selected_mcp,
        rules: rules.into_iter().map(FrozenCapability::from).collect(),
        hooks: hooks.into_iter().map(FrozenCapability::from).collect(),
        manifest,
    })
}

/// Standalone capture belongs before the scheduler's write transaction. Verify this stamp
/// immediately after BEGIN IMMEDIATE and before its first write, then persist
/// source with the real Run in that same transaction. This conservative fence
/// rejects even unrelated intervening DB writes; it never silently refreezes.
#[derive(Clone, Copy)]
pub(crate) struct BundleSourceDatabaseStamp {
    total_changes: u64,
    data_version: i64,
}
impl BundleSourceDatabaseStamp {
    pub(crate) fn capture(connection: &rusqlite::Connection) -> Result<Self> {
        Ok(Self {
            total_changes: connection.total_changes(),
            data_version: connection.query_row("PRAGMA data_version", [], |row| row.get(0))?,
        })
    }
    pub(crate) fn verify(&self, connection: &rusqlite::Connection) -> Result<()> {
        let current = Self::capture(connection)?;
        ensure!(
            self.total_changes == current.total_changes
                && self.data_version == current.data_version,
            "bundle_source_changed"
        );
        Ok(())
    }
}
pub(crate) struct CapturedMemberBundleSource {
    pub source: FrozenBundleSource,
    pub stamp: BundleSourceDatabaseStamp,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FrozenCapability {
    id: String,
    name: String,
    body: String,
    origin: String,
}
impl From<crate::member_capability::ProjectedCapability> for FrozenCapability {
    fn from(value: crate::member_capability::ProjectedCapability) -> Self {
        Self {
            id: value.id,
            name: value.name,
            body: value.body,
            origin: value.origin,
        }
    }
}
impl FrozenCapability {
    fn projection(&self) -> crate::member_capability::ProjectedCapability {
        crate::member_capability::ProjectedCapability {
            id: self.id.clone(),
            name: self.name.clone(),
            body: self.body.clone(),
            origin: self.origin.clone(),
        }
    }
}

/// Serializable, key-free source bytes fixed before a real Run is created.
/// Fields stay private. Runtime binding only changes real Run/attempt identity
/// and the existing ContextService's frozen bootstrap; it never re-reads stores.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FrozenBundleSource {
    version: u32,
    member_id: String,
    adapter: AdapterKind,
    selection_revision: String,
    source_skill_root: String,
    default_bootstrap: String,
    files: Vec<SkillFileSource>,
    skill_index: Vec<SkillIndexEntry>,
    platform_skill_index: Vec<SkillIndexEntry>,
    servers: BTreeMap<String, McpServerDefinition>,
    mcp_ids: BTreeMap<String, String>,
    rules: Vec<FrozenCapability>,
    hooks: Vec<FrozenCapability>,
    manifest: Value,
}
impl std::fmt::Debug for FrozenBundleSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FrozenBundleSource")
            .field("file_count", &self.files.len())
            .field("rule_count", &self.rules.len())
            .field("hook_count", &self.hooks.len())
            .finish_non_exhaustive()
    }
}
impl FrozenBundleSource {
    pub(crate) fn member_id(&self) -> &str {
        &self.member_id
    }
    pub(crate) fn adapter_kind(&self) -> AdapterKind {
        self.adapter
    }
    pub(crate) fn selection_revision(&self) -> &str {
        &self.selection_revision
    }
    pub(crate) fn digest(&self) -> Result<String> {
        let bytes = serde_json::to_vec(self)?;
        ensure!(bytes.len() <= 4 * 1024 * 1024, "bundle_source_size");
        Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
    }
    /// Whether this frozen source carries a credential reference. The frozen
    /// bytes answer it; the live MCP store is never read for this.
    pub fn has_mcp_references(&self) -> bool {
        super::selected_mcp_has_references(&self.servers)
    }
    /// Exposure metadata from the exact frozen key-free source. No local MCP
    /// file is created and no environment/store is consulted on this path.
    pub(crate) fn prepared_mcp_projection(
        &self,
    ) -> Result<crate::mcp_projection::PreparedMcpProjection> {
        use crate::mcp_projection::{
            McpExposureEntry, McpExposureSnapshot, McpExposureStatus, PreparedMcpProjection,
        };
        validate_mcp_servers(&self.servers)?;
        ensure!(
            self.mcp_ids.len() == self.servers.len(),
            "bundle_mcp_source_invalid"
        );
        let capability = crate::agent_runtime_adapter::AgentRuntimeAdapterRegistry::default()
            .mcp_projection(self.adapter);
        let mut snapshot = McpExposureSnapshot {
            config_digest: self.manifest["mcpSourceDigest"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("bundle_mcp_source_invalid"))?
                .to_string(),
            config_status: "ready".into(),
            projection_mode: capability.external_mcp_projection,
            same_name_policy: capability.same_name_policy,
            warnings: Vec::new(),
            servers: Vec::new(),
            ..McpExposureSnapshot::default()
        };
        for (name, definition) in &self.servers {
            let server_id = self
                .mcp_ids
                .get(name)
                .ok_or_else(|| anyhow::anyhow!("bundle_mcp_source_invalid"))?;
            let config_digest = format!(
                "sha256:{:x}",
                Sha256::digest(serde_json::to_vec(definition)?)
            );
            snapshot.servers.push(McpExposureEntry {
                server_id: server_id.clone(),
                name: name.clone(),
                runtime_name: name.clone(),
                transport: definition.transport_name().to_string(),
                config_digest,
                status: McpExposureStatus::Ready,
                reason: None,
            });
        }
        let projection_digest = format!(
            "sha256:{:x}",
            Sha256::digest(serde_json::to_vec(&(&snapshot, &self.servers))?)
        );
        Ok(PreparedMcpProjection {
            snapshot,
            projection_digest,
            canonical_path: std::path::PathBuf::new(),
            servers: self.servers.clone(),
        })
    }
    pub(crate) fn bind_real_run(
        &self,
        agent_run_id: &str,
        execution_epoch: u64,
        attempt: u32,
        bootstrap: &str,
    ) -> Result<FrozenMemberBundle> {
        ensure!(
            agent_run_id != "run_snapshot"
                && execution_epoch >= 1
                && execution_epoch <= (1_u64 << 53) - 1,
            "bundle_real_run_identity"
        );
        let mut frozen = self.bind(agent_run_id, attempt, bootstrap)?;
        // These are the same enforced native policy settings used by Core's
        // local Claude driver. They add no optional capability or model text.
        if self.adapter == AdapterKind::ClaudeCodeCli {
            install_claude_host_policy(&mut frozen.bundle)?;
            frozen.manifest["nativePolicy"] = json!({
                "claudeDisableAutoMemory":true, "claudeDisableBackgroundTasks":true
            });
        }
        frozen.manifest["agentRunId"] = json!(agent_run_id);
        frozen.manifest["executionEpoch"] = json!(execution_epoch);
        frozen.manifest["frozenSourceDigest"] = json!(self.digest()?);
        Ok(frozen)
    }
    fn reviewed_hooks(&self) -> Result<Vec<crate::member_capability::FrozenHookReview>> {
        match self.manifest.get("hookReviews") {
            Some(value) => serde_json::from_value(value.clone())
                .map_err(|_| anyhow::anyhow!("bundle_hook_review_invalid")),
            None if self.hooks.is_empty() => Ok(Vec::new()),
            None => anyhow::bail!("bundle_hook_review_required"),
        }
    }

    /// The immutable source must match the real Run's frozen workspace authority.
    /// Future member selection or future consent never substitutes for this proof.
    pub(crate) fn validate_hook_scope(
        &self, target: &crate::remote_execution::FrozenRunTarget,
    ) -> Result<()> {
        let reviews = self.reviewed_hooks()?;
        let hooks = self.hooks.iter().map(FrozenCapability::projection).collect::<Vec<_>>();
        crate::member_capability::validate_frozen_hook_reviews(&reviews, &hooks)?;
        crate::member_capability::validate_frozen_hook_scope(&reviews, target)
    }

    /// Grant only the settings rebuilt from this Run's approved immutable source.
    pub(crate) fn codex_hook_grant(
        &self, bundle: &RunBundleV1,
    ) -> Result<Option<loom_protocol::command_hooks::CodexHookGrantV1>> {
        if self.adapter != AdapterKind::CodexCli || self.hooks.is_empty() { return Ok(None); }
        let hooks = self.hooks.iter().map(FrozenCapability::projection).collect::<Vec<_>>();
        let reviews = self.reviewed_hooks()?;
        crate::member_capability::validate_frozen_hook_reviews(&reviews, &hooks)?;
        ensure!(bundle.agent_id == self.member_id && bundle.selection_revision == self.selection_revision,
            "bundle_hook_grant_scope");
        let expected = super::hook_settings(loom_protocol::run_bundle::ADAPTER_CODEX_CLI, &hooks)?
            .ok_or_else(|| anyhow::anyhow!("bundle_hook_settings_required"))?;
        let (bytes, _) = loom_protocol::command_hooks::settings(bundle)
            .map_err(anyhow::Error::msg)?.ok_or_else(|| anyhow::anyhow!("bundle_hook_settings_required"))?;
        ensure!(bytes == expected, "bundle_hook_grant_settings");
        let grant = loom_protocol::command_hooks::CodexHookGrantV1 {
            version: loom_protocol::command_hooks::CODEX_HOOK_GRANT_VERSION,
            settings_digest: loom_protocol::command_hooks::digest(&bytes),
            review_digest: crate::member_capability::frozen_review_digest(&reviews)?,
        };
        grant.validate(bundle).map_err(anyhow::Error::msg)?;
        Ok(Some(grant))
    }

    fn bind(&self, run_id: &str, attempt: u32, bootstrap: &str) -> Result<FrozenMemberBundle> {
        ensure!(self.version == 1, "bundle_source_version");
        let _ = self.digest()?;
        let rules = self
            .rules
            .iter()
            .map(FrozenCapability::projection)
            .collect::<Vec<_>>();
        let hooks = self
            .hooks
            .iter()
            .map(FrozenCapability::projection)
            .collect::<Vec<_>>();
        let reviews = self.reviewed_hooks()?;
        crate::member_capability::validate_frozen_hook_reviews(&reviews, &hooks)?;
        let bundle = build_remote_run_bundle(&RunBundleBuildRequest {
            run_id,
            attempt,
            agent_id: &self.member_id,
            adapter_kind: self.adapter,
            selection_revision: &self.selection_revision,
            source_skill_root: &self.source_skill_root,
            bootstrap,
            selected_skills: &self.files,
            skill_index: &self.skill_index,
            platform_skill_index: &self.platform_skill_index,
            mcp_servers: &self.servers,
            rules: &rules,
            hooks: &hooks,
        })?;
        Ok(FrozenMemberBundle {
            bundle,
            manifest: self.manifest.clone(),
        })
    }
}

fn install_claude_host_policy(bundle: &mut RunBundleV1) -> Result<()> {
    use loom_protocol::run_bundle::{self, BundleArtifact, BundleExpectation};
    let mut settings = match bundle
        .files
        .iter()
        .find(|file| file.artifact == BundleArtifact::RuntimeSettings)
    {
        Some(file) => serde_json::from_slice::<Value>(
            &run_bundle::decode_file(file).map_err(|_| anyhow::anyhow!("bundle_content"))?,
        )?,
        None => json!({}),
    };
    let object = settings
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("bundle_native_config"))?;
    ensure!(
        object.keys().all(|key| key == "hooks"),
        "bundle_native_config"
    );
    object.insert(
        "env".into(),
        json!({
            "CLAUDE_CODE_DISABLE_AUTO_MEMORY":"1",
            "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS":"1"
        }),
    );
    let bytes = serde_json::to_vec(&settings)?;
    let file = super::text_file(
        BundleArtifact::RuntimeSettings,
        run_bundle::LABEL_SETTINGS,
        &bytes,
    )?;
    if let Some(existing) = bundle
        .files
        .iter_mut()
        .find(|file| file.artifact == BundleArtifact::RuntimeSettings)
    {
        *existing = file;
    } else {
        bundle.files.push(file);
        bundle.files.sort_by(|left, right| {
            left.artifact
                .rank()
                .cmp(&right.artifact.rank())
                .then_with(|| left.label.cmp(&right.label))
        });
    }
    bundle.digest =
        run_bundle::bundle_digest(bundle).map_err(|_| anyhow::anyhow!("bundle_digest"))?;
    run_bundle::validate(
        bundle,
        &BundleExpectation {
            run_id: &bundle.run_id,
            attempt: bundle.attempt,
            adapter_kind: &bundle.adapter_kind,
        },
    )
    .map_err(|_| anyhow::anyhow!("bundle_content"))?;
    Ok(())
}

/// Existing standalone B7 freeze keeps its original profile-rendered contract.
pub(crate) fn freeze_member_bundle(
    database: &Database,
    data_dir: &Path,
    store: &McpConfigStore,
    params: &FreezeMemberBundleParams,
) -> Result<FrozenMemberBundle> {
    let captured = capture_member_bundle_source(database, data_dir, store, params)?;
    captured
        .source
        .bind("run_snapshot", 1, &captured.source.default_bootstrap)
}

/// A reference is resolved on the receiver, so A only proves the server is a
/// supported transport on a runtime that can resolve it. A reference is refused
/// outright where the native expansion was not verified: only the probed Codex
/// dialect may carry one.
fn qualify_reference_servers(
    servers: &BTreeMap<String, McpServerDefinition>,
    adapter: AdapterKind,
    reported_runtime_version: Option<&str>,
) -> Result<()> {
    for (name, definition) in servers {
        if adapter != AdapterKind::CodexCli
            || !super::codex_supports_mcp_references(reported_runtime_version)
        {
            return Err(BundleSourceError::error(
                "bundle_mcp_reference_runtime_unsupported",
                name,
            ));
        }
        crate::mcp_projection::mcp_projection_transport_supported(
            adapter,
            reported_runtime_version,
            definition.transport_name(),
        )
        .map_err(|_| BundleSourceError::error("bundle_selected_mcp_unavailable", name))?;
    }
    Ok(())
}

fn frozen_skill_digest(files: &[SkillFileSource], name: &str) -> String {
    let mut digest = Sha256::new();
    for file in files.iter().filter(|file| file.name == name) {
        digest.update((file.relative_path.len() as u64).to_be_bytes());
        digest.update(file.relative_path.as_bytes());
        digest.update((file.content.len() as u64).to_be_bytes());
        digest.update(&file.content);
    }
    format!("sha256:{:x}", digest.finalize())
}

/// Shared with the per-Run selected Skill material: one budget, one link rule.
pub(crate) fn collect_skill_files(
    root: &Path,
    directory: &Path,
    name: &str,
    files: &mut Vec<SkillFileSource>,
    total: &mut usize,
) -> Result<()> {
    let metadata = fs::symlink_metadata(directory)
        .map_err(|_| BundleSourceError::error("bundle_skill_source_unavailable", name))?;
    reject_link(&metadata, name)?;
    ensure!(metadata.is_dir(), "bundle_skill_source_unavailable");
    let mut entries = fs::read_dir(directory)?.collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)?;
        reject_link(&metadata, name)?;
        if metadata.is_dir() {
            collect_skill_files(root, &path, name, files, total)?;
        } else if metadata.is_file() {
            if metadata.len() > MAX_BUNDLE_FILE_BYTES as u64 || files.len() >= MAX_BUNDLE_FILES - 3
            {
                return Err(BundleSourceError::error("bundle_size", name));
            }
            let relative_path = path
                .strip_prefix(root)?
                .to_str()
                .ok_or_else(|| BundleSourceError::error("bundle_path", name))?
                .replace('\\', "/");
            safe_bundle_relative(&format!("skills/{name}/{relative_path}"))
                .map_err(|_| BundleSourceError::error("bundle_path", name))?;
            let mut content = Vec::new();
            fs::File::open(&path)?
                .take(MAX_BUNDLE_FILE_BYTES as u64 + 1)
                .read_to_end(&mut content)?;
            if content.len() > MAX_BUNDLE_FILE_BYTES {
                return Err(BundleSourceError::error("bundle_size", name));
            }
            *total = total.saturating_add(content.len());
            if *total > MAX_BUNDLE_DECODED_BYTES {
                return Err(BundleSourceError::error("bundle_size", name));
            }
            files.push(SkillFileSource {
                name: name.to_string(),
                relative_path,
                content,
            });
        } else {
            return Err(BundleSourceError::error(
                "bundle_skill_source_unavailable",
                name,
            ));
        }
    }
    Ok(())
}

fn reject_link(metadata: &fs::Metadata, name: &str) -> Result<()> {
    let linked = metadata.file_type().is_symlink();
    #[cfg(windows)]
    let linked = {
        use std::os::windows::fs::MetadataExt;
        linked || metadata.file_attributes() & 0x400 != 0
    };
    if linked {
        return Err(BundleSourceError::error("bundle_skill_source_linked", name));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use loom_protocol::run_bundle::BundleArtifact;

    // This owner exercises real catalog selection plus real managed Skill
    // source capture. Pure builder fixtures cannot catch accidental inclusion
    // of an unselected catalog entry, stale source reads or preview reuse.
    // Smallest command: cargo test -p rovai-core --lib remote_run_bundle::source::
    #[test]
    fn catalog_capture_freezes_selected_sources_and_next_run_observes_deselection() {
        let directory =
            std::env::temp_dir().join(format!("loom-bundle-source-{}", uuid::Uuid::new_v4()));
        let directory =
            crate::platform::private_storage::prepare_private_directory(&directory).unwrap();
        let mut database = Database::open(&directory).unwrap();
        let store = McpConfigStore::new(directory.join("mcp.json"));
        let library = crate::skill::SkillLibraryService::new(directory.join("skill-library")).unwrap();
        let member = AgentProfileService::default()
            .list_profiles(&database)
            .unwrap()[0]
            .agent_id
            .clone();
        let params = FreezeMemberBundleParams {
            member_id: member.clone(),
            runtime: "claude-code".into(),
            reported_runtime_version: None,
        };
        database.connection().execute(
            "INSERT INTO member_toolbox_skill(agent_id,skill_name,updated_at) VALUES(?1,'campfire',datetime('now'))",
            [&member],
        ).unwrap();
        database.connection().execute(
            "INSERT INTO member_capability_item(item_id,kind,name,source_label,scope,body,created_at) VALUES('fixture_rule','rule','Fixture rule','fixture','project','  frozen rule body  ',datetime('now'))",
            [],
        ).unwrap();
        let captured =
            capture_member_bundle_source(&database, &directory, &store, &params).unwrap();
        captured.stamp.verify(database.connection()).unwrap();
        // Extend this catalog owner: the real scheduler must keep the same
        // transaction through capture and Run insertion. Previously a nested
        // capture would fail, and standalone use must never silently succeed.
        assert!(capture_in_existing_transaction(&database, &directory, &store, &params).is_err());
        let changes = database.connection().total_changes();
        let outer = rusqlite::Transaction::new_unchecked(
            database.connection(),
            rusqlite::TransactionBehavior::Immediate,
        )
        .unwrap();
        let same_tx =
            capture_in_existing_transaction(&database, &directory, &store, &params).unwrap();
        assert!(!database.connection().is_autocommit());
        assert_eq!(changes, database.connection().total_changes());
        assert_eq!(same_tx.digest().unwrap(), captured.source.digest().unwrap());
        outer.rollback().unwrap();
        assert!(database.connection().is_autocommit());
        let serialized = serde_json::to_vec(&captured.source).unwrap();
        let restored: FrozenBundleSource = serde_json::from_slice(&serialized).unwrap();
        assert_eq!(
            restored.digest().unwrap(),
            captured.source.digest().unwrap()
        );
        let real_bootstrap = format!(
            "{}\nActual Run frozen bootstrap",
            restored.default_bootstrap
        );
        let bound = restored
            .bind_real_run("actual_run", 7, 1, &real_bootstrap)
            .unwrap();
        assert_eq!(bound.bundle.run_id, "actual_run");
        assert_eq!(bound.bundle.attempt, 1);
        assert_eq!(bound.manifest["executionEpoch"], 7);
        let settings = bound
            .bundle
            .files
            .iter()
            .find(|f| f.artifact == BundleArtifact::RuntimeSettings)
            .unwrap();
        let settings: Value =
            serde_json::from_slice(&STANDARD.decode(&settings.content).unwrap()).unwrap();
        assert_eq!(settings["env"]["CLAUDE_CODE_DISABLE_AUTO_MEMORY"], "1");
        assert_eq!(settings["env"]["CLAUDE_CODE_DISABLE_BACKGROUND_TASKS"], "1");
        assert!(settings.get("hooks").is_none());
        assert!(
            restored
                .bind_real_run("run_snapshot", 7, 1, &real_bootstrap)
                .is_err()
        );
        assert!(
            restored
                .prepared_mcp_projection()
                .unwrap()
                .canonical_path
                .as_os_str()
                .is_empty()
        );
        let bound_bytes = serde_json::to_vec(&bound.bundle).unwrap();
        let first = freeze_member_bundle(&database, &directory, &store, &params).unwrap();
        let before = serde_json::to_vec(&first.bundle).unwrap();
        assert!(
            first
                .bundle
                .files
                .iter()
                .any(|file| file.label == "campfire/SKILL.md")
        );
        assert!(
            !first
                .bundle
                .files
                .iter()
                .any(|file| file.label.starts_with("review-duo/"))
        );
        let prompt = first
            .bundle
            .files
            .iter()
            .find(|file| file.artifact == BundleArtifact::BootstrapPrompt)
            .unwrap();
        let prompt = String::from_utf8(STANDARD.decode(&prompt.content).unwrap()).unwrap();
        assert!(prompt.ends_with("  frozen rule body  "));
        let mandatory = first.manifest["assets"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|asset| asset["mandatory"] == true)
            .count();
        assert_eq!(mandatory, 2);
        database
            .connection()
            .execute(
                "DELETE FROM member_toolbox_skill WHERE agent_id=?1",
                [&member],
            )
            .unwrap();
        database.connection().execute("UPDATE member_capability_item SET body='changed rule' WHERE item_id='fixture_rule'", []).unwrap();
        assert!(captured.stamp.verify(database.connection()).is_err());
        assert_eq!(
            serde_json::to_vec(
                &restored
                    .bind_real_run("actual_run", 7, 1, &real_bootstrap)
                    .unwrap()
                    .bundle
            )
            .unwrap(),
            bound_bytes
        );
        let next = freeze_member_bundle(&database, &directory, &store, &params).unwrap();
        assert_eq!(before, serde_json::to_vec(&first.bundle).unwrap());
        assert_ne!(first.bundle.digest, next.bundle.digest);
        assert!(
            !next
                .bundle
                .files
                .iter()
                .any(|file| file.label.starts_with("campfire/"))
        );
        assert_eq!(
            next.bundle
                .files
                .iter()
                .filter(|file| file.label.ends_with("/SKILL.md"))
                .count(),
            2
        );
        // Exact consent becomes immutable Run source evidence. A later save
        // cannot authorize an older unreviewed snapshot or rewrite a reviewed one.
        use crate::member_capability::{
            get_member_capability_catalog, set_member_capability_catalog, put_capability_item,
            MemberCapabilityPutParams, MemberCapabilitySetParams, MemberCapabilitySelection,
            HookReviewApproval,
        };
        let review_scope = crate::member_capability::test_remote_scope(&mut database, &member, &directory);
        let body=r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"fixture-command","timeout":5}]}]}}"#;
        put_capability_item(&database,&store,&library,&MemberCapabilityPutParams {
            item_id:Some("source_hook".into()),kind:"hook".into(),name:Some("Source hook".into()),
            note:Some("Fixture".into()),source_label:Some("Fixture".into()),scope:Some("project".into()),
            tool_names:Vec::new(),body:Some(body.into()),
        }).unwrap();
        let codex_params=FreezeMemberBundleParams {
            member_id:member.clone(),runtime:"codex-cli".into(),reported_runtime_version:None,
        };
        assert!(capture_member_bundle_source(&database,&directory,&store,&codex_params).is_err());
        let catalog=get_member_capability_catalog(&database,&store,&member).unwrap();
        let view=catalog.items.iter().find(|item|item.id=="source_hook").unwrap().hook_definition.as_ref().unwrap();
        set_member_capability_catalog(&mut database,&store,&library,&MemberCapabilitySetParams {
            agent_id:member.clone(),expected_revision:catalog.revision.clone(),acknowledge_high_risk:false,
            selections:Vec::new(),
            reviewed_hooks:vec![HookReviewApproval{id:"source_hook".into(),definition_digest:view.definition_digest.clone(),scope_digest:view.scope_digest.clone()}],
        }).unwrap();
        let reviewed=capture_member_bundle_source(&database,&directory,&store,&codex_params).unwrap().source;
        let exact=reviewed.bind_real_run("reviewed_run",9,1,&reviewed.default_bootstrap).unwrap();
        let grant=reviewed.codex_hook_grant(&exact.bundle).unwrap().unwrap();
        grant.validate(&exact.bundle).unwrap();
        let reviewed_bytes=serde_json::to_vec(&reviewed).unwrap();
        assert_eq!(reviewed.manifest["hookReviews"][0]["reviewScope"], serde_json::to_value(&review_scope).unwrap());
        let mut missing=serde_json::to_value(&reviewed).unwrap();
        missing["manifest"].as_object_mut().unwrap().remove("hookReviews");
        let unreviewed:FrozenBundleSource=serde_json::from_value(missing).unwrap();
        assert!(unreviewed.bind_real_run("old_unreviewed_run",9,1,&reviewed.default_bootstrap).is_err());

        database.connection().execute(
            "UPDATE member_capability_item SET body=?1 WHERE item_id='source_hook'",
            [body.replace("fixture-command","later-command")],
        ).unwrap();
        assert!(capture_member_bundle_source(&database,&directory,&store,&codex_params).is_err());
        assert_eq!(reviewed_bytes,serde_json::to_vec(&reviewed).unwrap());
        assert_eq!(exact.bundle.digest,reviewed.bind_real_run("reviewed_run",9,1,&reviewed.default_bootstrap).unwrap().bundle.digest);
        assert_eq!(reviewed.codex_hook_grant(&exact.bundle).unwrap(),Some(grant.clone()));
        let current=get_member_capability_catalog(&database,&store,&member).unwrap();
        let view=current.items.iter().find(|item|item.id=="source_hook").unwrap().hook_definition.as_ref().unwrap();
        let newer=set_member_capability_catalog(&mut database,&store,&library,&MemberCapabilitySetParams {
            agent_id:member.clone(),expected_revision:current.revision.clone(),acknowledge_high_risk:false,
            selections:Vec::new(),
            reviewed_hooks:vec![HookReviewApproval{id:"source_hook".into(),definition_digest:view.definition_digest.clone(),scope_digest:view.scope_digest.clone()}],
        }).unwrap();
        assert!(unreviewed.bind_real_run("old_unreviewed_run",9,1,&reviewed.default_bootstrap).is_err());
        set_member_capability_catalog(&mut database,&store,&library,&MemberCapabilitySetParams {
            agent_id:member.clone(),expected_revision:newer.revision,acknowledge_high_risk:false,
            selections:vec![MemberCapabilitySelection{kind:"hook".into(),id:"source_hook".into(),selected:false}],
            reviewed_hooks:Vec::new(),
        }).unwrap();
        let off=capture_member_bundle_source(&database,&directory,&store,&codex_params).unwrap().source;
        let off_bundle=off.bind_real_run("next_without_hook",10,1,&off.default_bootstrap).unwrap();
        assert!(off.codex_hook_grant(&off_bundle.bundle).unwrap().is_none());
        assert_eq!(reviewed.codex_hook_grant(&exact.bundle).unwrap(),Some(grant));

        // Imported Library Skills: real import, real catalog registration, real
        // selection and real capture. The frozen bytes must come from the
        // revision that was current at capture time, never from a later one.
        use crate::command::CommandEnvelope;
        use crate::skill::CommitSkillImportCommand;

        fn import_library_skill(
            database: &mut Database,
            library: &crate::skill::SkillLibraryService,
            source_root: &Path,
            name: &str,
            description: &str,
            body: &str,
            confirm_update: bool,
        ) -> crate::skill::SkillView {
            let directory = source_root.join(name);
            fs::create_dir_all(directory.join("resources")).unwrap();
            fs::write(
                directory.join("SKILL.md"),
                format!("---\nname: {name}\ndescription: {description}\n---\n\n{body}\n"),
            )
            .unwrap();
            fs::write(
                directory.join("resources").join("notes.md"),
                format!("{body} resource\n"),
            )
            .unwrap();
            let inspection = library.inspect_import(database, &directory).unwrap();
            let candidate = inspection.candidates[0].clone();
            let expected_version = candidate.existing_skill_version;
            library
                .commit_import(
                    database,
                    &CommandEnvelope {
                        command_id: format!("import-{name}-{body}"),
                        actor: crate::command::ActorRef::User {
                            user_id: "bundle-source-test-user".into(),
                        },
                        camp_id: None,
                        expected_versions: Vec::new(),
                        execution_epoch: None,
                        payload: CommitSkillImportCommand {
                            staging_token: inspection.staging_token,
                            candidate_name: candidate.name.clone(),
                            expected_digest: candidate.content_digest,
                            expected_skill_version: expected_version,
                            confirm_update,
                        },
                    },
                )
                .unwrap();
            library
                .list(database)
                .unwrap()
                .into_iter()
                .find(|skill| skill.name == candidate.name)
                .unwrap()
        }

        // Drop the hook fixture so its consent state cannot mask Skill capture.
        database
            .connection()
            .execute("DELETE FROM member_capability_item WHERE item_id='source_hook'", [])
            .unwrap();
        database
            .connection()
            .execute("DELETE FROM member_capability_choice WHERE kind='hook'", [])
            .unwrap();
        let import_root = directory.join("library-import-source");
        let first = import_library_skill(
            &mut database,
            &library,
            &import_root,
            "field-notes",
            "Field notes",
            "first body",
            false,
        );
        let library_id = format!("library:{}", first.id);
        let register_params = || MemberCapabilityPutParams {
            item_id: Some(library_id.clone()),
            kind: "skill".into(),
            name: Some("field-notes".into()),
            note: Some("Fixture".into()),
            source_label: Some("Fixture".into()),
            scope: Some("project".into()),
            tool_names: Vec::new(),
            body: None,
        };
        put_capability_item(&database, &store, &library, &register_params()).unwrap();
        let catalog = get_member_capability_catalog(&database, &store, &member).unwrap();
        assert!(
            catalog
                .items
                .iter()
                .any(|item| item.id == library_id && item.kind == "skill" && !item.selected)
        );
        set_member_capability_catalog(
            &mut database,
            &store,
            &library,
            &MemberCapabilitySetParams {
                agent_id: member.clone(),
                expected_revision: catalog.revision.clone(),
                acknowledge_high_risk: false,
                selections: vec![MemberCapabilitySelection {
                    kind: "skill".into(),
                    id: library_id.clone(),
                    selected: true,
                }],
                reviewed_hooks: Vec::new(),
            },
        )
        .unwrap();
        let v1 = capture_member_bundle_source(&database, &directory, &store, &params)
            .unwrap()
            .source;
        let v1_bytes = serde_json::to_vec(&v1).unwrap();
        let v1_bound = v1
            .bind_real_run("library_run", 11, 1, &v1.default_bootstrap)
            .unwrap();
        assert!(
            v1_bound
                .bundle
                .files
                .iter()
                .any(|file| file.label == "field-notes/SKILL.md")
        );
        assert!(
            v1_bound
                .bundle
                .files
                .iter()
                .any(|file| file.label == "field-notes/resources/notes.md")
        );
        assert!(
            v1.skill_index
                .iter()
                .any(|entry| entry.name == "field-notes" && entry.desc == "Field notes")
        );
        let v1_asset = v1.manifest["assets"]
            .as_array()
            .unwrap()
            .iter()
            .find(|asset| asset["id"] == json!(library_id))
            .unwrap()
            .clone();
        assert_eq!(v1_asset["revision"], json!(first.current_revision.id));
        assert_eq!(
            v1_asset["contentDigest"],
            json!(first.current_revision.content_digest)
        );
        assert_eq!(v1.manifest["selectionRevision"], json!(v1.selection_revision));
        // A new revision is a new source; the old frozen source keeps binding v1.
        let second = import_library_skill(
            &mut database,
            &library,
            &import_root,
            "field-notes",
            "Field notes",
            "second body",
            true,
        );
        assert_ne!(second.current_revision.id, first.current_revision.id);
        let v2 = capture_member_bundle_source(&database, &directory, &store, &params)
            .unwrap()
            .source;
        assert_ne!(v1.digest().unwrap(), v2.digest().unwrap());
        let v2_notes = v2
            .files
            .iter()
            .find(|file| file.name == "field-notes" && file.relative_path == "resources/notes.md")
            .unwrap();
        assert_eq!(
            String::from_utf8(v2_notes.content.clone()).unwrap(),
            "second body resource\n"
        );
        assert_eq!(
            v2.manifest["assets"]
                .as_array()
                .unwrap()
                .iter()
                .find(|asset| asset["id"] == json!(library_id))
                .unwrap()["revision"],
            json!(second.current_revision.id)
        );
        assert_eq!(v1_bytes, serde_json::to_vec(&v1).unwrap());
        assert_eq!(
            serde_json::to_vec(
                &v1.bind_real_run("library_run", 11, 1, &v1.default_bootstrap)
                    .unwrap()
                    .bundle
            )
            .unwrap(),
            serde_json::to_vec(&v1_bound.bundle).unwrap()
        );
        // Tampered, disabled and dangling sources fail closed instead of being
        // quietly left out of the packet.
        let revision_path = library.revision_content_path(&second.id, &second.current_revision.id);
        fs::write(revision_path.join("resources").join("notes.md"), "tampered\n").unwrap();
        assert!(capture_member_bundle_source(&database, &directory, &store, &params).is_err());
        fs::write(
            revision_path.join("resources").join("notes.md"),
            "second body resource\n",
        )
        .unwrap();
        assert!(capture_member_bundle_source(&database, &directory, &store, &params).is_ok());
        database
            .connection()
            .execute("UPDATE skill SET enabled=0 WHERE id=?1", [&second.id])
            .unwrap();
        assert!(capture_member_bundle_source(&database, &directory, &store, &params).is_err());
        database
            .connection()
            .execute("UPDATE skill SET enabled=1 WHERE id=?1", [&second.id])
            .unwrap();
        database
            .connection()
            .execute("DELETE FROM member_skill_source WHERE skill_id=?1", [&second.id])
            .unwrap();
        assert!(capture_member_bundle_source(&database, &directory, &store, &params).is_err());
        put_capability_item(&database, &store, &library, &register_params()).unwrap();
        // Deselecting drops the imported bytes, index entry and asset.
        let catalog = get_member_capability_catalog(&database, &store, &member).unwrap();
        set_member_capability_catalog(
            &mut database,
            &store,
            &library,
            &MemberCapabilitySetParams {
                agent_id: member.clone(),
                expected_revision: catalog.revision.clone(),
                acknowledge_high_risk: false,
                selections: vec![MemberCapabilitySelection {
                    kind: "skill".into(),
                    id: library_id.clone(),
                    selected: false,
                }],
                reviewed_hooks: Vec::new(),
            },
        )
        .unwrap();
        let off = capture_member_bundle_source(&database, &directory, &store, &params)
            .unwrap()
            .source;
        assert!(!off.files.iter().any(|file| file.name == "field-notes"));
        assert!(!off.skill_index.iter().any(|entry| entry.name == "field-notes"));
        assert!(
            !off.manifest["assets"]
                .as_array()
                .unwrap()
                .iter()
                .any(|asset| asset["id"] == json!(library_id))
        );
        // A builtin toolbox Skill selected through the same catalog still captures.
        let catalog = get_member_capability_catalog(&database, &store, &member).unwrap();
        set_member_capability_catalog(
            &mut database,
            &store,
            &library,
            &MemberCapabilitySetParams {
                agent_id: member.clone(),
                expected_revision: catalog.revision.clone(),
                acknowledge_high_risk: false,
                selections: vec![MemberCapabilitySelection {
                    kind: "skill".into(),
                    id: "campfire".into(),
                    selected: true,
                }],
                reviewed_hooks: Vec::new(),
            },
        )
        .unwrap();
        let builtin = capture_member_bundle_source(&database, &directory, &store, &params)
            .unwrap()
            .source;
        assert!(builtin.files.iter().any(|file| file.name == "campfire"));
        // Per-Run Skill material: the same real sources, frozen under one Run
        // uuid. Every assertion below opens the real published bytes.
        let material_root = directory.join("runtime").join("skills");
        let material_run = "6f4a1a2e-0000-4000-8000-000000000001";
        let next_material_run = "6f4a1a2e-0000-4000-8000-000000000002";
        let deselected_material_run = "6f4a1a2e-0000-4000-8000-000000000003";
        let catalog = get_member_capability_catalog(&database, &store, &member).unwrap();
        set_member_capability_catalog(
            &mut database,
            &store,
            &library,
            &MemberCapabilitySetParams {
                agent_id: member.clone(),
                expected_revision: catalog.revision.clone(),
                acknowledge_high_risk: false,
                selections: vec![MemberCapabilitySelection {
                    kind: "skill".into(),
                    id: library_id.clone(),
                    selected: true,
                }],
                reviewed_hooks: Vec::new(),
            },
        )
        .unwrap();
        fn material_for(
            database: &Database,
            directory: &Path,
            run_id: &str,
            member: &str,
        ) -> Option<(String, String)> {
            crate::context::prepared_additional_skills_for_test(
                database.connection(),
                directory,
                run_id,
                member,
            )
            .unwrap()
        }
        let (section, digest) = material_for(&database, &directory, material_run, &member).unwrap();
        let run_root = material_root.join(material_run).join("skills");
        let index: Value = serde_json::from_str(
            section
                .split_once("\nCurrent for this run; replaces any earlier Rovai Additional Skills.\n")
                .unwrap()
                .1
                .strip_suffix("\n[/ROVAI_ADDITIONAL_SKILLS]")
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            index["root"],
            json!(dunce::simplified(&run_root).to_str().unwrap())
        );
        assert!(index["skills"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["name"] == json!("field-notes")
                && entry["desc"] == json!("Field notes")));
        assert!(index["skills"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["name"] == json!("campfire")));
        // The index names real files under the index root, not a mirror hash.
        let imported_entry = fs::read_to_string(run_root.join("field-notes/SKILL.md")).unwrap();
        assert!(imported_entry.contains("second body"), "{imported_entry}");
        assert_eq!(
            fs::read_to_string(run_root.join("field-notes/resources/notes.md")).unwrap(),
            "second body resource\n"
        );
        assert!(run_root.join("campfire/SKILL.md").is_file());
        crate::context::validate_additional_skills_for_test(
            &directory,
            material_run,
            &member,
            &digest,
            &section,
        )
        .unwrap();

        // A candidate prefix captures in memory only: no directory exists until
        // the final selection publishes exactly that material.
        let pending_run = "6f4a1a2e-0000-4000-8000-000000000004";
        let pending_root = material_root.join(pending_run);
        let (pending_section, pending_digest, pending) =
            crate::context::capture_additional_skills_for_test(
                database.connection(),
                &directory,
                pending_run,
                &member,
            )
            .unwrap()
            .unwrap();
        assert!(!pending_root.exists());
        assert!(pending_section.contains("field-notes"));
        let pending = pending.unwrap();
        pending.publish(&directory).unwrap();
        assert!(
            fs::read_to_string(pending_root.join("skills/field-notes/SKILL.md"))
                .unwrap()
                .contains("second body")
        );
        assert!(pending_root.join("skills/campfire/SKILL.md").is_file());
        crate::context::validate_additional_skills_for_test(
            &directory,
            pending_run,
            &member,
            &pending_digest,
            &pending_section,
        )
        .unwrap();
        // Republishing the same material is verified, never rewritten.
        pending.publish(&directory).unwrap();

        // A newer source revision never reaches the frozen Run.
        let third = import_library_skill(
            &mut database,
            &library,
            &import_root,
            "field-notes",
            "Field notes",
            "third body",
            true,
        );
        assert_ne!(third.current_revision.id, second.current_revision.id);
        let (frozen_section, frozen_digest) = material_for(&database, &directory, material_run, &member).unwrap();
        assert_eq!((frozen_section, frozen_digest), (section.clone(), digest.clone()));
        assert!(
            fs::read_to_string(run_root.join("field-notes/SKILL.md"))
                .unwrap()
                .contains("second body")
        );
        let (next_section, next_digest) = material_for(&database, &directory, next_material_run, &member).unwrap();
        assert_ne!(next_section, section);
        assert_ne!(next_digest, digest);
        assert!(
            fs::read_to_string(
                material_root
                    .join(next_material_run)
                    .join("skills/field-notes/SKILL.md")
            )
            .unwrap()
            .contains("third body")
        );

        // Tampering and a lost directory fail closed: the marker never rebuilds
        // material from a newer source.
        let notes = run_root.join("field-notes/resources/notes.md");
        fs::write(&notes, "tampered\n").unwrap();
        assert!(
            crate::context::validate_additional_skills_for_test(
                &directory,
                material_run,
                &member,
                &digest,
                &section
            )
            .is_err()
        );
        fs::write(&notes, "second body resource\n").unwrap();
        crate::context::validate_additional_skills_for_test(
            &directory,
            material_run,
            &member,
            &digest,
            &section,
        )
        .unwrap();
        fs::remove_dir_all(material_root.join(material_run)).unwrap();
        assert!(
            crate::context::validate_additional_skills_for_test(
                &directory,
                material_run,
                &member,
                &digest,
                &section
            )
            .is_err()
        );
        assert!(!material_root.join(material_run).exists());

        // A Run without an imported source keeps the historical bytes and owns
        // no directory at all.
        let catalog = get_member_capability_catalog(&database, &store, &member).unwrap();
        set_member_capability_catalog(
            &mut database,
            &store,
            &library,
            &MemberCapabilitySetParams {
                agent_id: member.clone(),
                expected_revision: catalog.revision.clone(),
                acknowledge_high_risk: false,
                selections: vec![MemberCapabilitySelection {
                    kind: "skill".into(),
                    id: library_id.clone(),
                    selected: false,
                }],
                reviewed_hooks: Vec::new(),
            },
        )
        .unwrap();
        assert!(material_for(&database, &directory, deselected_material_run, &member).is_none());
        assert!(!material_root.join(deselected_material_run).exists());

        // Cleanup keeps names this owner does not own and drops only its own Run
        // uuid directories whose Run is no longer live.
        let unknown = material_root.join("not-a-run-uuid");
        fs::create_dir_all(unknown.join("nested")).unwrap();
        fs::write(unknown.join("nested/keep.txt"), "keep\n").unwrap();
        crate::mcp_projection::McpProjectionService::new(&directory)
            .cleanup_terminal_and_orphaned(&database)
            .unwrap();
        assert!(unknown.join("nested/keep.txt").is_file());
        assert!(!material_root.join(next_material_run).exists());
        drop(database);
        fs::remove_dir_all(directory).unwrap();
    }
}
