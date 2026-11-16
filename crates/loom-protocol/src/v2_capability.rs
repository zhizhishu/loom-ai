//! LOOM V2 Lane C: the capability contract for Skill / MCP / Rule / Hook.
//!
//! Pure serde: no filesystem, database, clock, randomness or runtime effect, so
//! Core can freeze a snapshot and admit evidence before anything is materialized.
//! Selecting never means loaded and loading never means invoked: a [`LoadReceipt`]
//! exists only through [`LoadReceipt::issue`] against a frozen `Prepared` entry,
//! and an [`InvokeEvidence`] only through a usable receipt for the same asset.
//! `Unsupported`, `Failed` and `Revoked` entries never yield a usable receipt.
//!
//! Memory is a separate fifth layer, not a fifth [`CapabilityKind`]: `"memory"`
//! does not parse. OS grants, file/terminal/browser authority and real approval
//! enforcement stay in Core and DevicePort; this module grants no authority.

use serde::{Deserialize, Serialize};

/// Proposal wire version of every object below.
pub const CAPABILITY_API_VERSION: &str = "loom.v2alpha1";

/// The only reason this module invents: no declared target covers this host.
pub const UNSUPPORTED_TARGET_REASON: &str = "capability_unsupported_target";

const MAX_TEXT: usize = 200;
const MAX_TIME: usize = 40;

/// `[A-Za-z0-9][A-Za-z0-9._:-]{1,127}`, the schema identifier shape.
fn identifier(value: &str) -> bool {
    let bytes = value.as_bytes();
    (2..=128).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

/// `sha256:` plus 64 lowercase hex digits.
fn digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value.as_bytes()[7..]
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

/// Non-empty bounded text without control characters. Timestamps are opaque
/// RFC 3339 text; this module never reads a clock.
fn plain(value: &str, maximum: usize) -> bool {
    !value.trim().is_empty() && value.len() <= maximum && !value.chars().any(char::is_control)
}

/// The four selectable capabilities, deliberately closed. `memory` is owned by
/// the separate memory layer, so it is not a fifth variant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CapabilityKind {
    Skill,
    Mcp,
    Rule,
    Hook,
}

/// Exactly four; a compile-time guard against a silent fifth variant.
pub const CAPABILITY_KINDS: [CapabilityKind; 4] = [
    CapabilityKind::Skill,
    CapabilityKind::Mcp,
    CapabilityKind::Rule,
    CapabilityKind::Hook,
];

/// Canonical LOOM hook events. Each materializer declares them
/// `native`/`adapted`/`unsupported`; the semantics are never forced 1:1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum HookEvent {
    #[serde(rename = "run.before")]
    RunBefore,
    #[serde(rename = "model.before")]
    ModelBefore,
    #[serde(rename = "tool.before")]
    ToolBefore,
    #[serde(rename = "tool.after")]
    ToolAfter,
    #[serde(rename = "run.after")]
    RunAfter,
    #[serde(rename = "approval.requested")]
    ApprovalRequested,
    #[serde(rename = "run.failed")]
    RunFailed,
}

/// Host platform. `Any` is only meaningful inside a manifest target list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Windows,
    Linux,
    Macos,
    Any,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TargetSupport {
    Native,
    Adapted,
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityTarget {
    /// Runtime identifier only; the closed runtime enum is owned elsewhere.
    pub runtime_kind: String,
    pub platform: Platform,
    pub support: TargetSupport,
    pub materializer_version: Option<String>,
}

/// Who owns a selection. Explicit, because `scope` plus `scope_id` alone cannot
/// say whether a Bot owns a binding or a workspace merely recommends it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OwnerKind {
    User,
    Workspace,
    Bot,
    Team,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityOwner {
    pub kind: OwnerKind,
    pub id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CapabilityScope {
    User,
    Workspace,
    Project,
    Bot,
    Team,
}

/// A project lives inside a workspace, so a workspace owner may bind it.
fn scope_allows(owner: OwnerKind, scope: CapabilityScope) -> bool {
    matches!(
        (owner, scope),
        (OwnerKind::User, CapabilityScope::User)
            | (OwnerKind::Workspace, CapabilityScope::Workspace)
            | (OwnerKind::Workspace, CapabilityScope::Project)
            | (OwnerKind::Bot, CapabilityScope::Bot)
            | (OwnerKind::Team, CapabilityScope::Team)
    )
}

/// Immutable asset. The digest covers the content, so a changed kind cannot keep
/// the same binding.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityManifest {
    pub asset_id: String,
    pub kind: CapabilityKind,
    pub asset_version: String,
    pub content_digest: String,
    pub provider: String,
    pub reference: String,
    pub targets: Vec<CapabilityTarget>,
    pub required_grants: Vec<String>,
    pub hook_events: Vec<HookEvent>,
}

impl CapabilityManifest {
    pub fn validate(&self) -> Result<(), CapabilityReject> {
        if !identifier(&self.asset_id)
            || !digest(&self.content_digest)
            || !plain(&self.asset_version, MAX_TEXT)
            || !plain(&self.provider, MAX_TEXT)
            || !plain(&self.reference, MAX_TEXT)
            || self.required_grants.iter().any(|grant| !identifier(grant))
        {
            return Err(CapabilityReject::Identity);
        }
        if self.targets.is_empty() {
            return Err(CapabilityReject::Target);
        }
        let mut seen: Vec<(&str, Platform)> = Vec::with_capacity(self.targets.len());
        for target in &self.targets {
            if !identifier(&target.runtime_kind) {
                return Err(CapabilityReject::Target);
            }
            if let Some(version) = target.materializer_version.as_deref()
                && !plain(version, MAX_TEXT)
            {
                return Err(CapabilityReject::Identity);
            }
            if seen.contains(&(target.runtime_kind.as_str(), target.platform)) {
                return Err(CapabilityReject::Duplicate);
            }
            seen.push((target.runtime_kind.as_str(), target.platform));
        }
        // A hook event list on a non-hook asset would let a Skill claim hook
        // semantics; a Hook without an event could never be registered.
        if self.kind == CapabilityKind::Hook {
            if self.hook_events.is_empty() {
                return Err(CapabilityReject::HookEvent);
            }
        } else if !self.hook_events.is_empty() {
            return Err(CapabilityReject::Kind);
        }
        let mut events = self.hook_events.clone();
        events.sort();
        events.dedup();
        if events.len() != self.hook_events.len() {
            return Err(CapabilityReject::HookEvent);
        }
        Ok(())
    }

    /// Exact `(runtime, platform)` wins, then `(runtime, any)`; no match is
    /// unsupported, never an optimistic default.
    pub fn support_for(&self, runtime_kind: &str, platform: Platform) -> TargetSupport {
        let find = |wanted: Platform| {
            self.targets
                .iter()
                .find(|target| target.runtime_kind == runtime_kind && target.platform == wanted)
                .map(|target| target.support)
        };
        find(platform)
            .or_else(|| find(Platform::Any))
            .unwrap_or(TargetSupport::Unsupported)
    }
}

/// Mutable, revisioned selection. `enabled == false` is not a selection at all.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityBinding {
    pub binding_id: String,
    pub asset_id: String,
    pub asset_digest: String,
    pub owner: CapabilityOwner,
    pub scope: CapabilityScope,
    pub scope_id: String,
    pub enabled: bool,
    pub revision: u32,
}

impl CapabilityBinding {
    pub fn validate(&self) -> Result<(), CapabilityReject> {
        if !identifier(&self.binding_id)
            || !identifier(&self.asset_id)
            || !identifier(&self.scope_id)
            || !digest(&self.asset_digest)
            || self.revision == 0
        {
            return Err(CapabilityReject::Identity);
        }
        if !identifier(&self.owner.id) || !scope_allows(self.owner.kind, self.scope) {
            return Err(CapabilityReject::OwnerScope);
        }
        if !self.enabled {
            return Err(CapabilityReject::Disabled);
        }
        Ok(())
    }

    pub fn matches(&self, manifest: &CapabilityManifest) -> Result<(), CapabilityReject> {
        if self.asset_id != manifest.asset_id || self.asset_digest != manifest.content_digest {
            return Err(CapabilityReject::Asset);
        }
        Ok(())
    }
}

/// The readable lifecycle. `Selected` and `Loaded` are different phases, and a
/// frozen snapshot may only carry the four frozen ones.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CapabilityPhase {
    Discovered,
    Inspected,
    Selected,
    Configured,
    Prepared,
    Loaded,
    Invoked,
    Evidenced,
    Unsupported,
    Failed,
    Revoked,
}

const LINEAR: [CapabilityPhase; 8] = [
    CapabilityPhase::Discovered,
    CapabilityPhase::Inspected,
    CapabilityPhase::Selected,
    CapabilityPhase::Configured,
    CapabilityPhase::Prepared,
    CapabilityPhase::Loaded,
    CapabilityPhase::Invoked,
    CapabilityPhase::Evidenced,
];

impl CapabilityPhase {
    /// The only phases a frozen snapshot may claim.
    pub fn is_frozen(self) -> bool {
        matches!(
            self,
            Self::Prepared | Self::Unsupported | Self::Failed | Self::Revoked
        )
    }

    /// Phases that only runtime evidence may assert, never a frozen snapshot.
    pub fn is_usable_evidence(self) -> bool {
        matches!(self, Self::Loaded | Self::Invoked | Self::Evidenced)
    }

    /// A stop phase must explain itself; a live or usable phase must not.
    fn is_stop(self) -> bool {
        matches!(self, Self::Unsupported | Self::Failed | Self::Revoked)
    }

    /// Only `Evidenced` closes the happy path. `Loaded` and `Invoked` are still
    /// live: `Loaded -> Invoked -> Evidenced` must stay walkable, while a stop
    /// or `Evidenced` must never resume.
    fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Evidenced | Self::Unsupported | Self::Failed | Self::Revoked
        )
    }

    fn linear_index(self) -> Option<usize> {
        LINEAR.iter().position(|phase| *phase == self)
    }

    /// One step forward, or a stop. Skips, regressions and escapes from a
    /// terminal phase are refused, so `Selected` can never reach `Loaded`.
    pub fn advance(self, next: Self) -> Result<Self, CapabilityReject> {
        if self.is_terminal() {
            return Err(CapabilityReject::Phase);
        }
        if next.is_stop() {
            return Ok(next);
        }
        match (self.linear_index(), next.linear_index()) {
            (Some(current), Some(target)) if target == current + 1 => Ok(next),
            _ => Err(CapabilityReject::Phase),
        }
    }
}

/// One frozen row of a snapshot: what Core resolved, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityEntry {
    pub asset_id: String,
    pub asset_digest: String,
    pub kind: CapabilityKind,
    pub binding_id: String,
    pub scope: CapabilityScope,
    pub scope_id: String,
    pub support: TargetSupport,
    pub hook_events: Vec<HookEvent>,
    pub phase: CapabilityPhase,
    pub reason_code: Option<String>,
}

impl CapabilityEntry {
    pub fn validate(&self) -> Result<(), CapabilityReject> {
        if !identifier(&self.asset_id)
            || !identifier(&self.binding_id)
            || !identifier(&self.scope_id)
            || !digest(&self.asset_digest)
        {
            return Err(CapabilityReject::Identity);
        }
        if self.kind == CapabilityKind::Hook {
            if self.hook_events.is_empty() {
                return Err(CapabilityReject::HookEvent);
            }
        } else if !self.hook_events.is_empty() {
            return Err(CapabilityReject::Kind);
        }
        Ok(())
    }

    /// Advance one live row under the same reason rule as a frozen snapshot.
    pub fn advance(&self, next: CapabilityPhase) -> Result<Self, CapabilityReject> {
        let mut advanced = self.clone();
        advanced.phase = self.phase.advance(next)?;
        let reason = advanced.reason_code.as_deref().unwrap_or("");
        if advanced.phase.is_stop() {
            if reason.trim().is_empty() {
                return Err(CapabilityReject::Reason);
            }
        } else if advanced.reason_code.is_some() {
            return Err(CapabilityReject::Reason);
        }
        Ok(advanced)
    }
}

/// Everything Core freezes for one RunAttempt, minus the assets themselves.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotIdentity {
    pub snapshot_id: String,
    pub owner: CapabilityOwner,
    pub workspace_id: String,
    pub runtime_kind: String,
    pub runtime_version: String,
    pub host_platform: Platform,
    pub resolver_version: String,
    pub created_at: String,
}

/// One selected pair to resolve. Core resolves precedence before calling freeze.
#[derive(Clone, Copy)]
pub struct CapabilitySelection<'a> {
    pub binding: &'a CapabilityBinding,
    pub manifest: &'a CapabilityManifest,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EffectiveCapabilitySnapshot {
    pub snapshot_id: String,
    pub owner: CapabilityOwner,
    pub workspace_id: String,
    pub runtime_kind: String,
    pub runtime_version: String,
    pub host_platform: Platform,
    pub resolver_version: String,
    pub entries: Vec<CapabilityEntry>,
    pub grant_refs: Vec<String>,
    pub snapshot_digest: String,
    pub created_at: String,
}

impl EffectiveCapabilitySnapshot {
    /// Resolve selected bindings into one immutable snapshot. A target the host
    /// runtime cannot serve freezes as `Unsupported`; it is never `Prepared`.
    pub fn freeze(
        identity: SnapshotIdentity,
        selections: &[CapabilitySelection<'_>],
        grant_refs: Vec<String>,
        snapshot_digest: String,
    ) -> Result<Self, CapabilityReject> {
        if identity.host_platform == Platform::Any {
            return Err(CapabilityReject::Identity);
        }
        let mut entries = Vec::with_capacity(selections.len());
        for selection in selections {
            selection.binding.validate()?;
            selection.manifest.validate()?;
            selection.binding.matches(selection.manifest)?;
            let support = selection
                .manifest
                .support_for(&identity.runtime_kind, identity.host_platform);
            let phase = if support == TargetSupport::Unsupported {
                CapabilityPhase::Unsupported
            } else {
                CapabilityPhase::Prepared
            };
            entries.push(CapabilityEntry {
                asset_id: selection.binding.asset_id.clone(),
                asset_digest: selection.binding.asset_digest.clone(),
                kind: selection.manifest.kind,
                binding_id: selection.binding.binding_id.clone(),
                scope: selection.binding.scope,
                scope_id: selection.binding.scope_id.clone(),
                support,
                hook_events: selection.manifest.hook_events.clone(),
                phase,
                reason_code: phase
                    .is_stop()
                    .then(|| UNSUPPORTED_TARGET_REASON.to_string()),
            });
        }
        // Deterministic order: two freezes of the same selection cannot differ.
        entries.sort_by(|left, right| left.asset_id.cmp(&right.asset_id));
        let snapshot = Self {
            snapshot_id: identity.snapshot_id,
            owner: identity.owner,
            workspace_id: identity.workspace_id,
            runtime_kind: identity.runtime_kind,
            runtime_version: identity.runtime_version,
            host_platform: identity.host_platform,
            resolver_version: identity.resolver_version,
            entries,
            grant_refs,
            snapshot_digest,
            created_at: identity.created_at,
        };
        snapshot.validate()?;
        Ok(snapshot)
    }

    pub fn validate(&self) -> Result<(), CapabilityReject> {
        if !identifier(&self.snapshot_id)
            || !identifier(&self.workspace_id)
            || !identifier(&self.runtime_kind)
            || !digest(&self.snapshot_digest)
            || !plain(&self.runtime_version, MAX_TEXT)
            || !plain(&self.resolver_version, MAX_TEXT)
            || !plain(&self.created_at, MAX_TIME)
            || self.host_platform == Platform::Any
            || self.grant_refs.iter().any(|grant| !identifier(grant))
        {
            return Err(CapabilityReject::Identity);
        }
        if self.owner.kind != OwnerKind::Bot || !identifier(&self.owner.id) {
            return Err(CapabilityReject::OwnerScope);
        }
        let mut previous: Option<&str> = None;
        for entry in &self.entries {
            entry.validate()?;
            if let Some(last) = previous {
                if entry.asset_id == last {
                    return Err(CapabilityReject::Duplicate);
                }
                if entry.asset_id.as_str() < last {
                    return Err(CapabilityReject::Order);
                }
            }
            previous = Some(entry.asset_id.as_str());
            if !entry.phase.is_frozen() {
                return Err(CapabilityReject::SnapshotPhase);
            }
            if entry.support == TargetSupport::Unsupported && !entry.phase.is_stop() {
                return Err(CapabilityReject::SnapshotPhase);
            }
            let reason = entry.reason_code.as_deref().unwrap_or("");
            if entry.phase.is_stop() {
                if reason.trim().is_empty() {
                    return Err(CapabilityReject::Reason);
                }
            } else if entry.reason_code.is_some() {
                return Err(CapabilityReject::Reason);
            }
        }
        Ok(())
    }

    pub fn entry(&self, asset_id: &str) -> Option<&CapabilityEntry> {
        self.entries.iter().find(|entry| entry.asset_id == asset_id)
    }

    /// The authority gate: a receipt is usable only against a snapshot that still
    /// holds this asset as `Prepared`. A later revocation, failure or unsupported
    /// resolution makes an earlier receipt unusable.
    pub fn admit(&self, receipt: &LoadReceipt) -> Result<(), CapabilityReject> {
        self.validate()?;
        receipt.validate()?;
        if receipt.snapshot_id != self.snapshot_id
            || receipt.snapshot_digest != self.snapshot_digest
            || receipt.runtime_kind != self.runtime_kind
            || receipt.owner != self.owner
        {
            return Err(CapabilityReject::Mismatch);
        }
        let entry = self
            .entry(&receipt.asset_id)
            .ok_or(CapabilityReject::Asset)?;
        if entry.asset_digest != receipt.asset_digest {
            return Err(CapabilityReject::Asset);
        }
        if entry.kind != receipt.kind {
            return Err(CapabilityReject::Kind);
        }
        if entry.scope != receipt.scope || entry.scope_id != receipt.scope_id {
            return Err(CapabilityReject::OwnerScope);
        }
        match entry.phase {
            CapabilityPhase::Prepared => Ok(()),
            CapabilityPhase::Unsupported => Err(CapabilityReject::Unsupported),
            CapabilityPhase::Failed => Err(CapabilityReject::Failed),
            CapabilityPhase::Revoked => Err(CapabilityReject::Revoked),
            _ => Err(CapabilityReject::Phase),
        }
    }

    /// Invocation needs the same usable receipt plus the per-kind call shape.
    pub fn admit_invoke(
        &self,
        receipt: &LoadReceipt,
        evidence: &InvokeEvidence,
    ) -> Result<(), CapabilityReject> {
        self.admit(receipt)?;
        evidence.validate()?;
        if evidence.snapshot_id != self.snapshot_id
            || evidence.snapshot_digest != self.snapshot_digest
            || evidence.runtime_kind != self.runtime_kind
            || evidence.owner != self.owner
        {
            return Err(CapabilityReject::Mismatch);
        }
        if evidence.asset_id != receipt.asset_id
            || evidence.asset_digest != receipt.asset_digest
            || evidence.kind != receipt.kind
            || evidence.scope != receipt.scope
            || evidence.scope_id != receipt.scope_id
            || evidence.load_event_id != receipt.event_id
            || evidence.load_proof_digest != receipt.proof_digest
        {
            return Err(CapabilityReject::Mismatch);
        }
        let entry = self
            .entry(&evidence.asset_id)
            .ok_or(CapabilityReject::Asset)?;
        match evidence.kind {
            // A tool call must name the native call that ran.
            CapabilityKind::Mcp => {
                if evidence
                    .tool_call_id
                    .as_deref()
                    .is_none_or(|call| call.trim().is_empty())
                {
                    return Err(CapabilityReject::ToolCall);
                }
            }
            // A rule is injected text; claiming a tool call would be false evidence.
            CapabilityKind::Rule => {
                if evidence.tool_call_id.is_some() {
                    return Err(CapabilityReject::ToolCall);
                }
            }
            CapabilityKind::Skill | CapabilityKind::Hook => {}
        }
        match evidence.kind {
            CapabilityKind::Hook => {
                let event = evidence.hook_event.ok_or(CapabilityReject::HookEvent)?;
                if !entry.hook_events.contains(&event) {
                    return Err(CapabilityReject::HookEvent);
                }
            }
            _ => {
                if evidence.hook_event.is_some() {
                    return Err(CapabilityReject::HookEvent);
                }
            }
        }
        Ok(())
    }
}

/// Native proof a runtime offers when it reports a load.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoadProof {
    pub event_id: String,
    pub proof_digest: String,
    pub materializer_version: Option<String>,
    pub loaded_at: String,
}

/// Evidence that a frozen `Prepared` capability was actually loaded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoadReceipt {
    pub snapshot_id: String,
    pub snapshot_digest: String,
    pub asset_id: String,
    pub asset_digest: String,
    pub kind: CapabilityKind,
    pub owner: CapabilityOwner,
    pub scope: CapabilityScope,
    pub scope_id: String,
    pub runtime_kind: String,
    pub materializer_version: Option<String>,
    pub event_id: String,
    pub proof_digest: String,
    pub loaded_at: String,
}

impl LoadReceipt {
    /// The only constructor. It copies identity from the snapshot and then re-runs
    /// [`EffectiveCapabilitySnapshot::admit`], so an `Unsupported`, `Failed` or
    /// `Revoked` entry cannot produce a receipt.
    pub fn issue(
        snapshot: &EffectiveCapabilitySnapshot,
        asset_id: &str,
        proof: LoadProof,
    ) -> Result<Self, CapabilityReject> {
        let entry = snapshot.entry(asset_id).ok_or(CapabilityReject::Asset)?;
        let receipt = Self {
            snapshot_id: snapshot.snapshot_id.clone(),
            snapshot_digest: snapshot.snapshot_digest.clone(),
            asset_id: entry.asset_id.clone(),
            asset_digest: entry.asset_digest.clone(),
            kind: entry.kind,
            owner: snapshot.owner.clone(),
            scope: entry.scope,
            scope_id: entry.scope_id.clone(),
            runtime_kind: snapshot.runtime_kind.clone(),
            materializer_version: proof.materializer_version,
            event_id: proof.event_id,
            proof_digest: proof.proof_digest,
            loaded_at: proof.loaded_at,
        };
        snapshot.admit(&receipt)?;
        Ok(receipt)
    }

    pub fn validate(&self) -> Result<(), CapabilityReject> {
        if !identifier(&self.snapshot_id)
            || !identifier(&self.asset_id)
            || !identifier(&self.scope_id)
            || !identifier(&self.event_id)
            || !identifier(&self.runtime_kind)
            || !identifier(&self.owner.id)
            || !digest(&self.snapshot_digest)
            || !digest(&self.asset_digest)
            || !digest(&self.proof_digest)
            || !plain(&self.loaded_at, MAX_TIME)
        {
            return Err(CapabilityReject::Identity);
        }
        if let Some(version) = self.materializer_version.as_deref()
            && !plain(version, MAX_TEXT)
        {
            return Err(CapabilityReject::Identity);
        }
        Ok(())
    }
}

/// Native proof a runtime offers when a loaded capability was used.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InvokeProof {
    pub event_id: String,
    pub proof_digest: String,
    pub tool_call_id: Option<String>,
    pub hook_event: Option<HookEvent>,
    pub invoked_at: String,
}

/// Evidence that a loaded capability was actually used. It always names the load
/// receipt it belongs to, so it can never be issued against a bare selection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InvokeEvidence {
    pub snapshot_id: String,
    pub snapshot_digest: String,
    pub asset_id: String,
    pub asset_digest: String,
    pub kind: CapabilityKind,
    pub owner: CapabilityOwner,
    pub scope: CapabilityScope,
    pub scope_id: String,
    pub runtime_kind: String,
    pub load_event_id: String,
    pub load_proof_digest: String,
    pub event_id: String,
    pub proof_digest: String,
    pub tool_call_id: Option<String>,
    pub hook_event: Option<HookEvent>,
    pub invoked_at: String,
}

impl InvokeEvidence {
    /// The only constructor: it needs a receipt, and every rule lives in
    /// [`EffectiveCapabilitySnapshot::admit_invoke`].
    pub fn issue(
        snapshot: &EffectiveCapabilitySnapshot,
        receipt: &LoadReceipt,
        proof: InvokeProof,
    ) -> Result<Self, CapabilityReject> {
        let evidence = Self {
            snapshot_id: snapshot.snapshot_id.clone(),
            snapshot_digest: snapshot.snapshot_digest.clone(),
            asset_id: receipt.asset_id.clone(),
            asset_digest: receipt.asset_digest.clone(),
            kind: receipt.kind,
            owner: receipt.owner.clone(),
            scope: receipt.scope,
            scope_id: receipt.scope_id.clone(),
            runtime_kind: snapshot.runtime_kind.clone(),
            load_event_id: receipt.event_id.clone(),
            load_proof_digest: receipt.proof_digest.clone(),
            event_id: proof.event_id,
            proof_digest: proof.proof_digest,
            tool_call_id: proof.tool_call_id,
            hook_event: proof.hook_event,
            invoked_at: proof.invoked_at,
        };
        snapshot.admit_invoke(receipt, &evidence)?;
        Ok(evidence)
    }

    pub fn validate(&self) -> Result<(), CapabilityReject> {
        if !identifier(&self.snapshot_id)
            || !identifier(&self.asset_id)
            || !identifier(&self.scope_id)
            || !identifier(&self.event_id)
            || !identifier(&self.load_event_id)
            || !identifier(&self.runtime_kind)
            || !identifier(&self.owner.id)
            || !digest(&self.snapshot_digest)
            || !digest(&self.asset_digest)
            || !digest(&self.proof_digest)
            || !digest(&self.load_proof_digest)
            || !plain(&self.invoked_at, MAX_TIME)
        {
            return Err(CapabilityReject::Identity);
        }
        if let Some(call) = self.tool_call_id.as_deref()
            && !identifier(call)
        {
            return Err(CapabilityReject::Identity);
        }
        Ok(())
    }
}

/// Typed refusal. `code()` is the stable wire code and never carries content.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CapabilityReject {
    /// An identifier, digest or timestamp has the wrong shape.
    Identity,
    /// Owner kind, scope, or snapshot ownership disagree.
    OwnerScope,
    /// A kind claim does not fit the object (for example hooks on a Skill).
    Kind,
    /// A hook event is missing, unknown or not declared by the manifest.
    HookEvent,
    /// Asset identity or digest disagrees, or the asset is not in the snapshot.
    Asset,
    /// The binding is switched off, so nothing was selected.
    Disabled,
    /// No usable target covers this runtime and host.
    Target,
    Duplicate,
    Order,
    /// A frozen snapshot claims a phase it may not claim.
    SnapshotPhase,
    /// Illegal transition: a skip, a regression, or an escape from a terminal.
    Phase,
    /// A stop lacks a reason, or a live/usable phase carries one.
    Reason,
    Unsupported,
    Failed,
    Revoked,
    /// Evidence belongs to another snapshot, asset, runtime, owner or receipt.
    Mismatch,
    /// The per-kind tool call shape is wrong.
    ToolCall,
}

impl CapabilityReject {
    pub fn code(self) -> &'static str {
        match self {
            Self::Identity => "capability_identity",
            Self::OwnerScope => "capability_owner_scope",
            Self::Kind => "capability_kind",
            Self::HookEvent => "capability_hook_event",
            Self::Asset => "capability_asset",
            Self::Disabled => "capability_disabled",
            Self::Target => "capability_target",
            Self::Duplicate => "capability_duplicate",
            Self::Order => "capability_order",
            Self::SnapshotPhase => "capability_snapshot_phase",
            Self::Phase => "capability_phase",
            Self::Reason => "capability_reason",
            Self::Unsupported => "capability_unsupported",
            Self::Failed => "capability_failed",
            Self::Revoked => "capability_revoked",
            Self::Mismatch => "capability_mismatch",
            Self::ToolCall => "capability_tool_call",
        }
    }
}

impl std::fmt::Display for CapabilityReject {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.code())
    }
}

impl std::error::Error for CapabilityReject {}

#[cfg(test)]
mod tests {
    //! Admission (docs/development/testing.md): this module is the only owner of
    //! the capability lifecycle, so before it existed nothing refused a receipt
    //! for a merely selected, unsupported or revoked capability. `run_bundle` owns
    //! per-Run file bundles and `command_hooks` owns Codex hook settings; neither
    //! owns selection, freeze or evidence, so these cases cannot extend them.
    //! Pure unit tests: no database, process or filesystem fixture.
    //! Minimal command: `cargo test -p loom-protocol v2_capability`.

    use super::*;

    const DIGEST_A: &str =
        "sha256:1111111111111111111111111111111111111111111111111111111111111111";
    const DIGEST_B: &str =
        "sha256:2222222222222222222222222222222222222222222222222222222222222222";
    const DIGEST_C: &str =
        "sha256:3333333333333333333333333333333333333333333333333333333333333333";
    const AT: &str = "2026-11-15T00:00:00Z";
    const REVIEW: &str = "asset.review";

    fn manifest(kind: CapabilityKind, asset_id: &str, digest: &str) -> CapabilityManifest {
        CapabilityManifest {
            asset_id: asset_id.to_string(),
            kind,
            asset_version: "1.0.0".to_string(),
            content_digest: digest.to_string(),
            provider: "project".to_string(),
            reference: "skills/review".to_string(),
            targets: vec![CapabilityTarget {
                runtime_kind: "pi".to_string(),
                platform: Platform::Windows,
                support: TargetSupport::Native,
                materializer_version: Some("mat-1".to_string()),
            }],
            required_grants: vec!["grant.file.read".to_string()],
            hook_events: if kind == CapabilityKind::Hook {
                vec![HookEvent::ToolBefore]
            } else {
                Vec::new()
            },
        }
    }

    fn binding(asset_id: &str, digest: &str) -> CapabilityBinding {
        CapabilityBinding {
            binding_id: "binding_1".to_string(),
            asset_id: asset_id.to_string(),
            asset_digest: digest.to_string(),
            owner: CapabilityOwner {
                kind: OwnerKind::Bot,
                id: "bot_1".to_string(),
            },
            scope: CapabilityScope::Bot,
            scope_id: "bot_1".to_string(),
            enabled: true,
            revision: 1,
        }
    }

    fn identity() -> SnapshotIdentity {
        SnapshotIdentity {
            snapshot_id: "snapshot_1".to_string(),
            owner: CapabilityOwner {
                kind: OwnerKind::Bot,
                id: "bot_1".to_string(),
            },
            workspace_id: "workspace_1".to_string(),
            runtime_kind: "pi".to_string(),
            runtime_version: "0.85.1".to_string(),
            host_platform: Platform::Windows,
            resolver_version: "resolver-1".to_string(),
            created_at: AT.to_string(),
        }
    }

    fn frozen_of(
        kind: CapabilityKind,
        asset_id: &str,
        digest: &str,
    ) -> EffectiveCapabilitySnapshot {
        let manifest = manifest(kind, asset_id, digest);
        let binding = binding(asset_id, digest);
        EffectiveCapabilitySnapshot::freeze(
            identity(),
            &[CapabilitySelection {
                binding: &binding,
                manifest: &manifest,
            }],
            vec!["grant.file.read".to_string()],
            DIGEST_B.to_string(),
        )
        .expect("frozen snapshot")
    }

    fn frozen() -> EffectiveCapabilitySnapshot {
        frozen_of(CapabilityKind::Skill, REVIEW, DIGEST_A)
    }

    /// A later Core snapshot that recorded a different outcome for the same asset.
    fn with_phase(
        snapshot: &EffectiveCapabilitySnapshot,
        phase: CapabilityPhase,
        reason: Option<&str>,
    ) -> EffectiveCapabilitySnapshot {
        let mut next = snapshot.clone();
        next.entries[0].phase = phase;
        next.entries[0].reason_code = reason.map(str::to_string);
        next
    }

    fn load(
        snapshot: &EffectiveCapabilitySnapshot,
        asset_id: &str,
        event_id: &str,
    ) -> Result<LoadReceipt, CapabilityReject> {
        LoadReceipt::issue(
            snapshot,
            asset_id,
            LoadProof {
                event_id: event_id.to_string(),
                proof_digest: DIGEST_C.to_string(),
                materializer_version: Some("mat-1".to_string()),
                loaded_at: AT.to_string(),
            },
        )
    }

    fn receipt(snapshot: &EffectiveCapabilitySnapshot) -> LoadReceipt {
        load(snapshot, REVIEW, "evt_load_1").expect("load receipt")
    }

    fn invoke() -> InvokeProof {
        InvokeProof {
            event_id: "evt_call_1".to_string(),
            proof_digest: DIGEST_A.to_string(),
            tool_call_id: None,
            hook_event: None,
            invoked_at: AT.to_string(),
        }
    }

    #[test]
    fn memory_is_not_a_fifth_capability_and_unknown_kinds_are_refused() {
        assert_eq!(CAPABILITY_KINDS.len(), 4);
        for kind in CAPABILITY_KINDS {
            let wire = serde_json::to_string(&kind).unwrap();
            assert_eq!(serde_json::from_str::<CapabilityKind>(&wire).unwrap(), kind);
        }
        // Memory is the separate fifth layer, so it is not a kind at all.
        for wire in ["\"memory\"", "\"agent\"", "\"Skill\"", "\"extension\""] {
            assert!(
                serde_json::from_str::<CapabilityKind>(wire).is_err(),
                "{wire} parsed as a capability kind"
            );
        }
    }

    #[test]
    fn owner_and_scope_must_be_explicit_and_compatible() {
        let mut wrong_owner = binding(REVIEW, DIGEST_A);
        wrong_owner.owner.kind = OwnerKind::User;
        assert_eq!(wrong_owner.validate(), Err(CapabilityReject::OwnerScope));

        let mut empty_owner = binding(REVIEW, DIGEST_A);
        empty_owner.owner.id = String::new();
        assert_eq!(empty_owner.validate(), Err(CapabilityReject::OwnerScope));

        let mut empty_scope = binding(REVIEW, DIGEST_A);
        empty_scope.scope_id = String::new();
        assert_eq!(empty_scope.validate(), Err(CapabilityReject::Identity));

        // A workspace owner may bind a project; a bot may not.
        let mut project = binding(REVIEW, DIGEST_A);
        project.scope = CapabilityScope::Project;
        project.owner.kind = OwnerKind::Workspace;
        assert_eq!(project.validate(), Ok(()));
        project.owner.kind = OwnerKind::Bot;
        assert_eq!(project.validate(), Err(CapabilityReject::OwnerScope));

        // The frozen snapshot belongs to the Bot whose attempt it is.
        let mut team_snapshot = frozen();
        team_snapshot.owner.kind = OwnerKind::Team;
        assert_eq!(team_snapshot.validate(), Err(CapabilityReject::OwnerScope));
    }

    #[test]
    fn binding_must_agree_with_its_manifest() {
        let manifest = manifest(CapabilityKind::Skill, REVIEW, DIGEST_A);
        assert_eq!(manifest.validate(), Ok(()));
        assert_eq!(binding(REVIEW, DIGEST_A).matches(&manifest), Ok(()));
        assert_eq!(
            binding("asset.other", DIGEST_A).matches(&manifest),
            Err(CapabilityReject::Asset)
        );
        assert_eq!(
            binding(REVIEW, DIGEST_B).matches(&manifest),
            Err(CapabilityReject::Asset)
        );

        let mut disabled = binding(REVIEW, DIGEST_A);
        disabled.enabled = false;
        assert_eq!(disabled.validate(), Err(CapabilityReject::Disabled));

        let mut no_revision = binding(REVIEW, DIGEST_A);
        no_revision.revision = 0;
        assert_eq!(no_revision.validate(), Err(CapabilityReject::Identity));

        let mut short_digest = binding(REVIEW, DIGEST_A);
        short_digest.asset_digest = "sha256:abc".to_string();
        assert_eq!(short_digest.validate(), Err(CapabilityReject::Identity));

        // Uppercase hex is not the contract's digest shape.
        let mut upper = manifest.clone();
        upper.content_digest = DIGEST_A.to_uppercase();
        assert_eq!(upper.validate(), Err(CapabilityReject::Identity));
    }

    #[test]
    fn hook_kind_declares_canonical_events_and_other_kinds_declare_none() {
        let mut hook = manifest(CapabilityKind::Hook, "asset.guard", DIGEST_A);
        assert_eq!(hook.validate(), Ok(()));
        assert_eq!(
            serde_json::to_string(&HookEvent::RunBefore).unwrap(),
            "\"run.before\""
        );

        hook.hook_events.clear();
        assert_eq!(hook.validate(), Err(CapabilityReject::HookEvent));

        hook.hook_events = vec![HookEvent::ToolBefore, HookEvent::ToolBefore];
        assert_eq!(hook.validate(), Err(CapabilityReject::HookEvent));

        let mut skill = manifest(CapabilityKind::Skill, REVIEW, DIGEST_A);
        skill.hook_events = vec![HookEvent::ToolBefore];
        assert_eq!(skill.validate(), Err(CapabilityReject::Kind));

        // A non-canonical native event name is not readable at all.
        assert!(serde_json::from_str::<HookEvent>("\"onSave\"").is_err());
    }

    #[test]
    fn a_selected_capability_cannot_be_frozen_or_loaded() {
        let prepared = frozen();
        assert_eq!(prepared.entries[0].phase, CapabilityPhase::Prepared);

        // A frozen snapshot may claim neither a pre-freeze nor a post-freeze phase.
        for phase in [
            CapabilityPhase::Discovered,
            CapabilityPhase::Inspected,
            CapabilityPhase::Selected,
            CapabilityPhase::Configured,
            CapabilityPhase::Loaded,
            CapabilityPhase::Invoked,
            CapabilityPhase::Evidenced,
        ] {
            assert_eq!(
                with_phase(&prepared, phase, None).validate(),
                Err(CapabilityReject::SnapshotPhase),
                "{phase:?} was accepted in a frozen snapshot"
            );
        }
        // The frozen phases are readable; a stop needs a reason, a live one forbids it.
        assert_eq!(
            with_phase(&prepared, CapabilityPhase::Prepared, None).validate(),
            Ok(())
        );
        assert_eq!(
            with_phase(&prepared, CapabilityPhase::Revoked, Some("revoked_by_user")).validate(),
            Ok(())
        );
        assert_eq!(
            with_phase(&prepared, CapabilityPhase::Revoked, None).validate(),
            Err(CapabilityReject::Reason)
        );
        assert_eq!(
            with_phase(&prepared, CapabilityPhase::Failed, Some("load_failed")).validate(),
            Ok(())
        );
        let mut prepared_with_reason = prepared.clone();
        prepared_with_reason.entries[0].reason_code = Some("stale".to_string());
        assert_eq!(
            prepared_with_reason.validate(),
            Err(CapabilityReject::Reason)
        );
    }

    #[test]
    fn unsupported_targets_never_yield_a_usable_receipt() {
        // The manifest only declares macOS, but the snapshot host is Windows.
        let mut manifest = manifest(CapabilityKind::Skill, REVIEW, DIGEST_A);
        manifest.targets[0].platform = Platform::Macos;
        let binding = binding(REVIEW, DIGEST_A);
        let snapshot = EffectiveCapabilitySnapshot::freeze(
            identity(),
            &[CapabilitySelection {
                binding: &binding,
                manifest: &manifest,
            }],
            Vec::new(),
            DIGEST_B.to_string(),
        )
        .expect("frozen snapshot");
        assert_eq!(snapshot.entries[0].support, TargetSupport::Unsupported);
        assert_eq!(snapshot.entries[0].phase, CapabilityPhase::Unsupported);
        assert_eq!(
            snapshot.entries[0].reason_code.as_deref(),
            Some(UNSUPPORTED_TARGET_REASON)
        );
        assert_eq!(
            load(&snapshot, REVIEW, "evt_load_1"),
            Err(CapabilityReject::Unsupported)
        );

        // An `any` target keeps a prepared capability loadable.
        let mut any = manifest.clone();
        any.targets[0].platform = Platform::Any;
        assert_eq!(
            any.support_for("pi", Platform::Windows),
            TargetSupport::Native
        );
        assert_eq!(
            any.support_for("codex", Platform::Windows),
            TargetSupport::Unsupported
        );

        // A claimed `Prepared` entry cannot sit on an unsupported resolution.
        let mut lying = frozen();
        lying.entries[0].support = TargetSupport::Unsupported;
        assert_eq!(lying.validate(), Err(CapabilityReject::SnapshotPhase));
    }

    #[test]
    fn revoked_and_failed_capabilities_never_yield_a_usable_receipt() {
        let prepared = frozen();
        let issued = receipt(&prepared);
        assert_eq!(prepared.admit(&issued), Ok(()));

        // A later snapshot that revoked the same asset invalidates the receipt.
        let revoked = with_phase(&prepared, CapabilityPhase::Revoked, Some("revoked_by_user"));
        assert_eq!(revoked.admit(&issued), Err(CapabilityReject::Revoked));
        assert_eq!(
            load(&revoked, REVIEW, "evt_load_2"),
            Err(CapabilityReject::Revoked)
        );

        let failed = with_phase(
            &prepared,
            CapabilityPhase::Failed,
            Some("materialize_failed"),
        );
        assert_eq!(failed.admit(&issued), Err(CapabilityReject::Failed));

        // An entry the snapshot no longer holds is not admitted either.
        let mut empty = prepared.clone();
        empty.entries.clear();
        assert_eq!(empty.admit(&issued), Err(CapabilityReject::Asset));
    }

    #[test]
    fn a_load_receipt_is_bound_to_its_snapshot_asset_runtime_and_owner() {
        let prepared = frozen();
        let issued = receipt(&prepared);
        assert_eq!(issued.validate(), Ok(()));
        assert_eq!(issued.snapshot_digest, DIGEST_B);

        let mut other_digest = prepared.clone();
        other_digest.snapshot_digest = DIGEST_C.to_string();
        assert_eq!(other_digest.admit(&issued), Err(CapabilityReject::Mismatch));

        let mut other_runtime = prepared.clone();
        other_runtime.runtime_kind = "codex".to_string();
        assert_eq!(
            other_runtime.admit(&issued),
            Err(CapabilityReject::Mismatch)
        );

        let mut other_owner = prepared.clone();
        other_owner.owner.id = "bot_2".to_string();
        assert_eq!(other_owner.admit(&issued), Err(CapabilityReject::Mismatch));

        let mut other_asset = issued.clone();
        other_asset.asset_digest = DIGEST_C.to_string();
        assert_eq!(prepared.admit(&other_asset), Err(CapabilityReject::Asset));

        let mut other_kind = issued.clone();
        other_kind.kind = CapabilityKind::Rule;
        assert_eq!(prepared.admit(&other_kind), Err(CapabilityReject::Kind));

        let mut other_scope = issued.clone();
        other_scope.scope_id = "team_1".to_string();
        assert_eq!(
            prepared.admit(&other_scope),
            Err(CapabilityReject::OwnerScope)
        );

        let mut bad_proof = issued.clone();
        bad_proof.proof_digest = "sha256:xyz".to_string();
        assert_eq!(prepared.admit(&bad_proof), Err(CapabilityReject::Identity));

        // Nothing but `issue` exists, and it needs a real frozen entry.
        assert_eq!(
            load(&prepared, "asset.missing", "evt_load_1"),
            Err(CapabilityReject::Asset)
        );
    }

    #[test]
    fn invoke_evidence_requires_a_usable_load_receipt_for_the_same_asset() {
        let prepared = frozen();
        let issued = receipt(&prepared);
        let evidence =
            InvokeEvidence::issue(&prepared, &issued, invoke()).expect("invoke evidence");
        assert_eq!(prepared.admit_invoke(&issued, &evidence), Ok(()));
        assert_eq!(evidence.load_event_id, issued.event_id);
        assert_eq!(evidence.load_proof_digest, issued.proof_digest);

        // The evidence chain is not decorative: breaking either link is refused.
        let mut other_load = evidence.clone();
        other_load.load_event_id = "evt_load_9".to_string();
        assert_eq!(
            prepared.admit_invoke(&issued, &other_load),
            Err(CapabilityReject::Mismatch)
        );
        let mut other_proof = evidence.clone();
        other_proof.load_proof_digest = DIGEST_A.to_string();
        assert_eq!(
            prepared.admit_invoke(&issued, &other_proof),
            Err(CapabilityReject::Mismatch)
        );
        let mut other_asset = evidence.clone();
        other_asset.asset_id = "asset.other".to_string();
        assert_eq!(
            prepared.admit_invoke(&issued, &other_asset),
            Err(CapabilityReject::Mismatch)
        );

        // Revocation after the fact blocks the invocation too.
        let revoked = with_phase(&prepared, CapabilityPhase::Revoked, Some("revoked_by_user"));
        assert_eq!(
            revoked.admit_invoke(&issued, &evidence),
            Err(CapabilityReject::Revoked)
        );
        // So does a receipt from another snapshot.
        let mut other_snapshot = prepared.clone();
        other_snapshot.snapshot_digest = DIGEST_A.to_string();
        assert_eq!(
            other_snapshot.admit_invoke(&issued, &evidence),
            Err(CapabilityReject::Mismatch)
        );
    }

    #[test]
    fn invoke_evidence_follows_the_kind_tool_call_and_hook_rules() {
        // MCP: a tool call must name the native call that ran.
        let mcp = frozen_of(CapabilityKind::Mcp, "asset.github", DIGEST_A);
        let mcp_receipt = load(&mcp, "asset.github", "evt_load_1").expect("mcp receipt");
        assert_eq!(
            InvokeEvidence::issue(&mcp, &mcp_receipt, invoke()),
            Err(CapabilityReject::ToolCall)
        );
        let mut with_call = invoke();
        with_call.tool_call_id = Some("tool_call_1".to_string());
        assert!(InvokeEvidence::issue(&mcp, &mcp_receipt, with_call).is_ok());

        // Rule: injection is not a tool call.
        let rule = frozen_of(CapabilityKind::Rule, "asset.rules", DIGEST_A);
        let rule_receipt = load(&rule, "asset.rules", "evt_load_1").expect("rule receipt");
        let mut rule_call = invoke();
        rule_call.tool_call_id = Some("tool_call_1".to_string());
        assert_eq!(
            InvokeEvidence::issue(&rule, &rule_receipt, rule_call),
            Err(CapabilityReject::ToolCall)
        );

        // Hook: the triggered event must be one the manifest declared.
        let hook = frozen_of(CapabilityKind::Hook, "asset.guard", DIGEST_A);
        let hook_receipt = load(&hook, "asset.guard", "evt_load_1").expect("hook receipt");
        let mut undeclared = invoke();
        undeclared.hook_event = Some(HookEvent::RunAfter);
        assert_eq!(
            InvokeEvidence::issue(&hook, &hook_receipt, undeclared),
            Err(CapabilityReject::HookEvent)
        );
        assert_eq!(
            InvokeEvidence::issue(&hook, &hook_receipt, invoke()),
            Err(CapabilityReject::HookEvent)
        );
        let mut declared = invoke();
        declared.hook_event = Some(HookEvent::ToolBefore);
        assert!(InvokeEvidence::issue(&hook, &hook_receipt, declared).is_ok());
    }

    #[test]
    fn phase_progression_refuses_skips_regressions_and_terminal_escapes() {
        // The linear happy path.
        let mut phase = CapabilityPhase::Discovered;
        for next in [
            CapabilityPhase::Inspected,
            CapabilityPhase::Selected,
            CapabilityPhase::Configured,
            CapabilityPhase::Prepared,
            CapabilityPhase::Loaded,
            CapabilityPhase::Invoked,
            CapabilityPhase::Evidenced,
        ] {
            phase = phase.advance(next).expect("linear step");
            assert_eq!(phase, next);
        }
        assert!(phase.is_usable_evidence());

        // Selecting is not loading, and preparing is not invoking.
        for (from, to) in [
            (CapabilityPhase::Selected, CapabilityPhase::Loaded),
            (CapabilityPhase::Selected, CapabilityPhase::Invoked),
            (CapabilityPhase::Prepared, CapabilityPhase::Invoked),
            (CapabilityPhase::Prepared, CapabilityPhase::Evidenced),
            (CapabilityPhase::Loaded, CapabilityPhase::Prepared),
            (CapabilityPhase::Selected, CapabilityPhase::Prepared),
        ] {
            assert_eq!(
                from.advance(to),
                Err(CapabilityReject::Phase),
                "{from:?}->{to:?}"
            );
        }

        // Any live phase may stop, but no terminal phase may resume.
        for stop in [
            CapabilityPhase::Unsupported,
            CapabilityPhase::Failed,
            CapabilityPhase::Revoked,
        ] {
            assert_eq!(CapabilityPhase::Prepared.advance(stop), Ok(stop));
            for resume in [CapabilityPhase::Prepared, CapabilityPhase::Loaded] {
                assert_eq!(stop.advance(resume), Err(CapabilityReject::Phase));
            }
        }
        assert_eq!(
            CapabilityPhase::Evidenced.advance(CapabilityPhase::Loaded),
            Err(CapabilityReject::Phase)
        );

        // The row-level stop keeps the reason rule.
        let mut entries = frozen().entries;
        let mut entry = entries.remove(0);
        assert_eq!(
            entry.advance(CapabilityPhase::Unsupported),
            Err(CapabilityReject::Reason)
        );
        entry.reason_code = Some("tool_timeout".to_string());
        assert_eq!(
            entry
                .advance(CapabilityPhase::Unsupported)
                .map(|next| next.phase),
            Ok(CapabilityPhase::Unsupported)
        );
        assert_eq!(
            entry.advance(CapabilityPhase::Loaded),
            Err(CapabilityReject::Reason)
        );
    }

    #[test]
    fn the_frozen_snapshot_is_deterministic_and_rejects_unknown_wire_fields() {
        let review = manifest(CapabilityKind::Skill, REVIEW, DIGEST_A);
        let audit = manifest(CapabilityKind::Rule, "asset.audit", DIGEST_C);
        let review_binding = binding(REVIEW, DIGEST_A);
        let audit_binding = binding("asset.audit", DIGEST_C);
        // Declared out of order: freeze sorts, so two runs cannot differ.
        let snapshot = EffectiveCapabilitySnapshot::freeze(
            identity(),
            &[
                CapabilitySelection {
                    binding: &review_binding,
                    manifest: &review,
                },
                CapabilitySelection {
                    binding: &audit_binding,
                    manifest: &audit,
                },
            ],
            Vec::new(),
            DIGEST_B.to_string(),
        )
        .expect("frozen snapshot");
        assert_eq!(snapshot.entries[0].asset_id, "asset.audit");
        assert_eq!(snapshot.entries[1].asset_id, REVIEW);

        let json = serde_json::to_string(&snapshot).unwrap();
        assert!(json.contains("\"snapshotId\":\"snapshot_1\""));
        assert!(json.contains("\"hookEvents\":[]"));
        assert_eq!(
            serde_json::from_str::<EffectiveCapabilitySnapshot>(&json).unwrap(),
            snapshot
        );

        // Unknown fields and unknown enum values are refused, not ignored.
        let extra = json.replacen('{', "{\"unexpected\":1,", 1);
        assert!(serde_json::from_str::<EffectiveCapabilitySnapshot>(&extra).is_err());
        let bad_phase = json.replacen("\"prepared\"", "\"enabled\"", 1);
        assert!(serde_json::from_str::<EffectiveCapabilitySnapshot>(&bad_phase).is_err());
        let receipt = receipt(&snapshot);
        let receipt_json = serde_json::to_string(&receipt).unwrap();
        assert_eq!(
            serde_json::from_str::<LoadReceipt>(&receipt_json).unwrap(),
            receipt
        );
        assert!(
            serde_json::from_str::<LoadReceipt>(&receipt_json.replacen('{', "{\"x\":0,", 1))
                .is_err()
        );

        // Duplicate and unsorted entries are refused instead of silently merged.
        let mut duplicate = snapshot.clone();
        let first = duplicate.entries[0].asset_id.clone();
        duplicate.entries[1].asset_id = first;
        assert_eq!(duplicate.validate(), Err(CapabilityReject::Duplicate));
        let mut unsorted = snapshot.clone();
        unsorted.entries.swap(0, 1);
        assert_eq!(unsorted.validate(), Err(CapabilityReject::Order));

        // A switched-off selection never reaches a snapshot at all.
        let mut disabled = binding("asset.audit", DIGEST_C);
        disabled.enabled = false;
        assert_eq!(
            EffectiveCapabilitySnapshot::freeze(
                identity(),
                &[CapabilitySelection {
                    binding: &disabled,
                    manifest: &audit,
                }],
                Vec::new(),
                DIGEST_B.to_string(),
            ),
            Err(CapabilityReject::Disabled)
        );
    }
}
