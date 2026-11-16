//! LOOM Core V2 domain identities and the two kinds of run target.
//!
//! Scope of this module is the domain contract only: typed identities, the
//! closed product Runtime set, and the difference between a run that really has
//! a managed Runtime installation and a device-only invocation that has none.
//! There is no filesystem, database, network, process or clock access here, and
//! nothing in this module grants authority: `grant_ref`, `workspace_ref` and
//! `trace_id` are **references only**, never credential values, and this module
//! never resolves them and never reads a secret.
//!
//! Identity rules:
//!
//! * Six identities exist and none of them impersonates another: [`BotId`]
//!   (`bot_`), [`GoalId`] (`goal_`), [`AssignmentId`] (`assignment_`),
//!   [`RunAttemptId`] (`attempt_`), [`DeviceId`] (`device_`) and
//!   [`InstallationId`] (`install_`). Each kind owns one wire prefix and every
//!   kind shares one body grammar, so a value minted for one kind cannot be
//!   read as another: `BotId::parse("goal_1")` is refused and the JSON
//!   `"bot_1"` never deserializes as a [`GoalId`]. A body may contain another
//!   kind's prefix text (`bot_goal_1`); the outer prefix alone decides the kind,
//!   so the result is still only a [`BotId`].
//! * [`RuntimeKind`] is closed to the four product runtimes — `pi`,
//!   `deepseek-harness`, `codex-cli` and `claude-code-cli`, the in-tree adapter
//!   ids from `workspace.rs`. ACP is a wire protocol, ACCP is the collaboration
//!   control plane and Pi Purge is a Pi extension; none of them is a fifth
//!   runtime, so none of them parses.
//! * [`RuntimeInvocation`] always carries an [`InstallationId`] and a
//!   [`RuntimeKind`]. Both fields are required, so "a runtime run without an
//!   installation" cannot be expressed at all.
//! * [`DeviceInvocation`] has no `installation_id`, no [`RuntimeKind`] and no
//!   adapter field, and it refuses unknown fields. A device-only target
//!   therefore cannot smuggle a fake CLI installation into its own wire shape:
//!   the key is refused, not ignored. A parent run attempt may appear only as
//!   [`DeviceInvocationOwner::RunAttempt`], which records the parent and is not
//!   a claim of runtime authority.
//! * Deserializing any of these types proves only that the bytes are *shaped*
//!   like the contract. Serde success is never authorization: Core must still
//!   resolve the real installation, device, workspace and grant.
//!
//! Fields stay public so the types remain plain data, which also means a caller
//! can mutate them; [`FrozenRunTarget::validate`] therefore re-checks version,
//! generations and references instead of claiming the Rust type is immutable.
//! Platform admission — for example Claude Code being discovery-only on Windows
//! — belongs to a later contract and is deliberately absent here.

use serde::{Deserialize, Serialize};

/// Wire version of every object in this module.
pub const V2_DOMAIN_VERSION: u32 = 1;

/// The `apiVersion` a later request envelope must carry. This module exports
/// the value and deliberately adds no field, because the envelope is not frozen
/// yet.
pub const V2_API_VERSION: &str = "loom.v2alpha1";

/// Longest body of one typed identity, in bytes, excluding its prefix.
pub const MAX_V2_ID_BYTES: usize = 128;

/// Longest reference string: `grant_ref`, `workspace_ref` or `trace_id`.
pub const MAX_REF_BYTES: usize = 512;

/// In-tree adapter id of the managed Pi runtime.
pub const ADAPTER_KIND_PI: &str = "pi";
/// In-tree adapter id of DeepSeek Harness.
pub const ADAPTER_KIND_DSH: &str = "deepseek-harness";
/// In-tree adapter id of Codex.
pub const ADAPTER_KIND_CODEX: &str = "codex-cli";
/// In-tree adapter id of Claude Code.
pub const ADAPTER_KIND_CLAUDE_CODE: &str = "claude-code-cli";

/// Why a V2 domain value was refused. `code()` is the stable spelling and never
/// contains caller-supplied text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DomainReject {
    /// Not an identity of this kind: wrong prefix, empty or over-long body, or
    /// a byte outside the closed body grammar.
    Id,
    /// Not one of the four product runtimes.
    RuntimeKind,
    /// A generation of zero, which would make the identity ambiguous.
    Generation,
    /// A version this module does not implement.
    Version,
    /// A blank, over-long or control-bearing reference.
    Reference,
}

impl DomainReject {
    /// Stable diagnostic spelling. Contains no caller-supplied text.
    pub fn code(self) -> &'static str {
        match self {
            Self::Id => "v2_domain_id",
            Self::RuntimeKind => "v2_domain_runtime_kind",
            Self::Generation => "v2_domain_generation",
            Self::Version => "v2_domain_version",
            Self::Reference => "v2_domain_reference",
        }
    }
}

impl std::fmt::Display for DomainReject {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for DomainReject {}

/// The one identity grammar: a kind prefix followed by a non-empty, bounded body
/// of ASCII letters, digits, `_` and `-`. Every kind uses this function, so no
/// kind can quietly be laxer than another.
fn valid_id_body(prefix: &str, value: &str) -> bool {
    let Some(body) = value.strip_prefix(prefix) else {
        return false;
    };
    (1..=MAX_V2_ID_BYTES).contains(&body.len())
        && body
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

/// A reference is a name Core resolves itself. It is never a credential value,
/// so it only has to be a bounded, non-blank, control-free string.
fn valid_ref(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= MAX_REF_BYTES && !value.chars().any(char::is_control)
}

/// All three references of one invocation. One rule for both target kinds.
fn references_ok(grant_ref: &str, workspace_ref: &str, trace_id: &str) -> Result<(), DomainReject> {
    if valid_ref(grant_ref) && valid_ref(workspace_ref) && valid_ref(trace_id) {
        Ok(())
    } else {
        Err(DomainReject::Reference)
    }
}

/// One identity kind: private body, prefix-checked construction only.
///
/// `try_from`/`into` give serde the same single check as [`parse`], so an
/// accepted JSON string is exactly an accepted identity. There is no public
/// constructor that skips the check and no `Default`.
macro_rules! typed_id {
    ($(#[$meta:meta])* $name:ident, $prefix:literal) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(try_from = "String", into = "String")]
        pub struct $name(String);

        impl $name {
            /// The one wire prefix this kind owns.
            pub const PREFIX: &'static str = $prefix;

            /// The only way to build this kind from wire text.
            pub fn parse(value: &str) -> Result<Self, DomainReject> {
                if valid_id_body(Self::PREFIX, value) {
                    Ok(Self(value.to_string()))
                } else {
                    Err(DomainReject::Id)
                }
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str(&self.0)
            }
        }

        impl TryFrom<String> for $name {
            type Error = DomainReject;

            fn try_from(value: String) -> Result<Self, Self::Error> {
                Self::parse(&value)
            }
        }

        impl From<$name> for String {
            fn from(value: $name) -> Self {
                value.0
            }
        }
    };
}

typed_id!(
    /// The durable Bot identity. Switching persona or runtime never changes it.
    BotId,
    "bot_"
);

typed_id!(
    /// One user request Core owns, with its step DAG.
    GoalId,
    "goal_"
);

typed_id!(
    /// One unit of assigned responsibility inside a Goal.
    AssignmentId,
    "assignment_"
);

typed_id!(
    /// One execution attempt. A retry is a new attempt, never the same one.
    RunAttemptId,
    "attempt_"
);

typed_id!(
    /// One paired device, which may run no Runtime at all.
    DeviceId,
    "device_"
);

typed_id!(
    /// One managed Runtime installation. Only a runtime target carries this.
    InstallationId,
    "install_"
);

/// The closed set of product runtimes. Serde reads and writes exactly the
/// in-tree adapter ids, so there is no second spelling to drift.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum RuntimeKind {
    #[serde(rename = "pi")]
    Pi,
    #[serde(rename = "deepseek-harness")]
    Dsh,
    #[serde(rename = "codex-cli")]
    Codex,
    #[serde(rename = "claude-code-cli")]
    ClaudeCode,
}

impl RuntimeKind {
    /// Every product runtime.
    pub const ALL: [Self; 4] = [Self::Pi, Self::Dsh, Self::Codex, Self::ClaudeCode];

    /// The in-tree adapter id: the same string serde reads and writes.
    pub fn adapter_kind(self) -> &'static str {
        match self {
            Self::Pi => ADAPTER_KIND_PI,
            Self::Dsh => ADAPTER_KIND_DSH,
            Self::Codex => ADAPTER_KIND_CODEX,
            Self::ClaudeCode => ADAPTER_KIND_CLAUDE_CODE,
        }
    }

    /// Closed lookup. ACP, ACCP, Pi Purge, Cursor and every other spelling is
    /// `None` rather than a fifth variant.
    pub fn from_adapter_kind(value: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|kind| (*kind).adapter_kind() == value)
    }

    /// Typed form of the same closed lookup.
    pub fn parse(value: &str) -> Result<Self, DomainReject> {
        Self::from_adapter_kind(value).ok_or(DomainReject::RuntimeKind)
    }
}

/// Who owns a device-only invocation.
///
/// `User` is written as an empty *struct* variant on purpose: serde's internally
/// tagged unit visitor silently ignores every remaining key, so a unit variant
/// would accept `{"kind":"user","runAttemptId":"attempt_1"}` and drop the
/// attempt. The empty struct variant refuses that key instead.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DeviceInvocationOwner {
    /// The invocation was issued by a run attempt. This records the parent, not
    /// runtime authority for the device operation.
    RunAttempt { run_attempt_id: RunAttemptId },
    /// The invocation was issued by a human. The user identity itself belongs to
    /// the identity contract, not to this module.
    User {},
}

/// A run that really has a managed Runtime installation.
///
/// `runtime` and `installation_id` are required fields, so a runtime run without
/// an installation cannot be expressed: this is the type-level half of the
/// anti-impersonation rule. The references are names Core resolves; none of them
/// is a credential value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeInvocation {
    pub version: u32,
    pub runtime: RuntimeKind,
    pub installation_id: InstallationId,
    pub installation_generation: u64,
    pub assignment_id: AssignmentId,
    pub run_attempt_id: RunAttemptId,
    pub grant_ref: String,
    pub workspace_ref: String,
    pub trace_id: String,
}

impl RuntimeInvocation {
    /// Re-checks what public fields allow a caller to change.
    pub fn validate(&self) -> Result<(), DomainReject> {
        if self.version != V2_DOMAIN_VERSION {
            return Err(DomainReject::Version);
        }
        if self.installation_generation == 0 {
            return Err(DomainReject::Generation);
        }
        references_ok(&self.grant_ref, &self.workspace_ref, &self.trace_id)
    }
}

/// A device-only invocation: DevicePort tools on a machine that may run no
/// Pi, DSH, Codex or Claude Code at all.
///
/// There is no `installation_id`, no [`RuntimeKind`] and no adapter field here,
/// and unknown fields are refused, so a device-only target cannot smuggle a CLI
/// installation into its own wire shape. The fields below are the whole
/// authority record: a device, a connection generation, the Goal it serves, its
/// owner and three references.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceInvocation {
    pub version: u32,
    pub device_id: DeviceId,
    pub connection_generation: u64,
    pub goal_id: GoalId,
    pub owner: DeviceInvocationOwner,
    pub grant_ref: String,
    pub workspace_ref: String,
    pub trace_id: String,
}

impl DeviceInvocation {
    /// Re-checks what public fields allow a caller to change.
    pub fn validate(&self) -> Result<(), DomainReject> {
        if self.version != V2_DOMAIN_VERSION {
            return Err(DomainReject::Version);
        }
        if self.connection_generation == 0 {
            return Err(DomainReject::Generation);
        }
        references_ok(&self.grant_ref, &self.workspace_ref, &self.trace_id)
    }
}

/// The frozen target of one run: either a managed runtime with a real
/// installation, or a device-only invocation with none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "target",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum FrozenRunTarget {
    Runtime { invocation: RuntimeInvocation },
    Device { invocation: DeviceInvocation },
}

impl FrozenRunTarget {
    pub fn validate(&self) -> Result<(), DomainReject> {
        match self {
            Self::Runtime { invocation } => invocation.validate(),
            Self::Device { invocation } => invocation.validate(),
        }
    }

    pub fn runtime(&self) -> Option<&RuntimeInvocation> {
        match self {
            Self::Runtime { invocation } => Some(invocation),
            Self::Device { .. } => None,
        }
    }

    pub fn device(&self) -> Option<&DeviceInvocation> {
        match self {
            Self::Device { invocation } => Some(invocation),
            Self::Runtime { .. } => None,
        }
    }
}

#[cfg(test)]
mod tests {
    //! One owner for the V2 identity contract: the six typed identities, the
    //! closed four-runtime set, and the split between a runtime target that must
    //! carry an installation and a device-only target that must not be able to.
    //!
    //! Admission (docs/development/testing.md): the contract owner is this pure
    //! module. `run_bundle.rs` only validates a v1 bundle's adapter alias and
    //! `workspace_rpc.rs` has no identity of these kinds, so nothing else covers
    //! typed V2 ids or the installation/device split; every negative case below
    //! is a way a caller could impersonate another identity kind or claim a CLI
    //! installation it does not have. The owner is a pure unit test, so no
    //! database, process or filesystem fixture is needed.

    use super::*;
    use crate::CLI_CATALOG;

    fn runtime_invocation() -> RuntimeInvocation {
        RuntimeInvocation {
            version: V2_DOMAIN_VERSION,
            runtime: RuntimeKind::Pi,
            installation_id: InstallationId::parse("install_pi_0851").expect("installation id"),
            installation_generation: 3,
            assignment_id: AssignmentId::parse("assignment_a1").expect("assignment id"),
            run_attempt_id: RunAttemptId::parse("attempt_1").expect("attempt id"),
            grant_ref: "grant_ref_1".to_string(),
            workspace_ref: "workspace_ref_1".to_string(),
            trace_id: "trace_1".to_string(),
        }
    }

    fn device_invocation() -> DeviceInvocation {
        DeviceInvocation {
            version: V2_DOMAIN_VERSION,
            device_id: DeviceId::parse("device_d1").expect("device id"),
            connection_generation: 2,
            goal_id: GoalId::parse("goal_g1").expect("goal id"),
            owner: DeviceInvocationOwner::User {},
            grant_ref: "grant_ref_1".to_string(),
            workspace_ref: "workspace_ref_1".to_string(),
            trace_id: "trace_1".to_string(),
        }
    }

    fn device_json() -> serde_json::Value {
        serde_json::to_value(FrozenRunTarget::Device {
            invocation: device_invocation(),
        })
        .expect("device target serializes")
    }

    #[test]
    fn v2_identity_kinds_round_trip_and_refuse_other_kinds_and_bad_bodies() {
        let kinds: [(&str, &str, fn(&str) -> bool); 6] = [
            ("bot_", "bot_b1", |value| BotId::parse(value).is_ok()),
            ("goal_", "goal_g1", |value| GoalId::parse(value).is_ok()),
            ("assignment_", "assignment_a1", |value| {
                AssignmentId::parse(value).is_ok()
            }),
            ("attempt_", "attempt_1", |value| {
                RunAttemptId::parse(value).is_ok()
            }),
            ("device_", "device_d1", |value| {
                DeviceId::parse(value).is_ok()
            }),
            ("install_", "install_pi_0851", |value| {
                InstallationId::parse(value).is_ok()
            }),
        ];

        // Every kind accepts its own wire value and refuses every other kind's,
        // so no identity can be presented as a different kind.
        for (prefix, wire, parse) in kinds {
            assert!(parse(wire), "{prefix} refused its own value {wire}");
            for (_, other, _) in kinds {
                if other != wire {
                    assert!(!parse(other), "{other} was accepted as {prefix}");
                }
            }
        }

        let bot = BotId::parse("bot_b1").expect("bot id");
        assert_eq!(bot.as_str(), "bot_b1");
        assert_eq!(bot.to_string(), "bot_b1");
        assert_eq!(serde_json::to_string(&bot).expect("json"), "\"bot_b1\"");
        assert_eq!(
            serde_json::from_str::<BotId>("\"bot_b1\"").expect("round trip"),
            bot
        );

        // Body grammar: empty, blank, punctuation, non-ASCII and control bytes.
        for bad in [
            "",
            "bot_",
            "bot_a b",
            "bot_a.b",
            "bot_a/b",
            "bot_ü",
            "bot_a\u{0}",
        ] {
            assert_eq!(BotId::parse(bad), Err(DomainReject::Id), "{bad:?} accepted");
        }
        let longest = format!("bot_{}", "a".repeat(MAX_V2_ID_BYTES));
        assert!(BotId::parse(&longest).is_ok());
        let too_long = format!("bot_{}", "a".repeat(MAX_V2_ID_BYTES + 1));
        assert_eq!(BotId::parse(&too_long), Err(DomainReject::Id));

        // The same rule applies through serde, not only through `parse`.
        let wrong_kind: Result<GoalId, _> = serde_json::from_str("\"bot_b1\"");
        let error = wrong_kind.expect_err("a bot id must not deserialize as a goal id");
        assert!(error.to_string().contains("v2_domain_id"), "{error}");
        assert!(serde_json::from_str::<BotId>("123").is_err());
        assert!(serde_json::from_str::<GoalId>("\"\"").is_err());

        // A body may contain another kind's prefix text; the outer prefix alone
        // decides the kind, so the value is still only a BotId.
        let nested = BotId::parse("bot_goal_g1").expect("outer prefix decides the kind");
        assert_eq!(nested.as_str(), "bot_goal_g1");
        assert_eq!(GoalId::parse(nested.as_str()), Err(DomainReject::Id));
    }

    #[test]
    fn runtime_kind_is_a_closed_set_of_the_four_product_runtimes() {
        assert_eq!(RuntimeKind::ALL.len(), 4);
        for kind in RuntimeKind::ALL {
            let wire = kind.adapter_kind();
            assert_eq!(
                serde_json::to_string(&kind).expect("serialize"),
                format!("\"{wire}\"")
            );
            assert_eq!(
                serde_json::from_str::<RuntimeKind>(&format!("\"{wire}\"")).expect("deserialize"),
                kind
            );
            assert_eq!(RuntimeKind::from_adapter_kind(wire), Some(kind));
            assert_eq!(RuntimeKind::parse(wire), Ok(kind));
            // The four V2 runtimes are the in-tree adapter ids, not a new
            // spelling invented here.
            assert!(
                CLI_CATALOG.iter().any(|entry| entry.0 == wire),
                "{wire} is not an in-tree adapter id"
            );
        }

        // ACP is a wire protocol, ACCP is the control plane, Pi Purge is a Pi
        // extension: none of them is a fifth runtime, and neither is a
        // non-canonical spelling of a real one.
        for value in [
            "acp",
            "accp",
            "pi-purge",
            "cursor-agent",
            "claude-code",
            "codex",
            "dsh",
            "deepseek",
            "PI",
            "pi ",
            "",
        ] {
            assert_eq!(
                RuntimeKind::parse(value),
                Err(DomainReject::RuntimeKind),
                "{value} parsed as a runtime"
            );
            assert!(
                serde_json::from_str::<RuntimeKind>(&format!("\"{value}\"")).is_err(),
                "{value} deserialized as a runtime"
            );
            assert_eq!(RuntimeKind::from_adapter_kind(value), None);
        }
    }

    #[test]
    fn a_runtime_target_requires_a_real_installation_and_a_run_attempt() {
        let target = FrozenRunTarget::Runtime {
            invocation: runtime_invocation(),
        };
        assert_eq!(target.validate(), Ok(()));
        assert!(target.runtime().is_some());
        assert!(target.device().is_none());
        let json = serde_json::to_string(&target).expect("serialize");
        assert!(json.contains("\"target\":\"runtime\""), "{json}");
        assert_eq!(
            serde_json::from_str::<FrozenRunTarget>(&json).expect("parse"),
            target
        );

        let base = serde_json::to_value(runtime_invocation()).expect("value");
        // No installation at all is not a runtime target.
        let mut missing = base.clone();
        let _ = missing
            .as_object_mut()
            .expect("object")
            .remove("installationId");
        assert!(serde_json::from_value::<RuntimeInvocation>(missing).is_err());
        // Empty, prefix-only and wrong-kind installation ids.
        for value in ["", "install_", "device_d1", "bot_b1"] {
            let mut wrong = base.clone();
            wrong["installationId"] = serde_json::json!(value);
            assert!(
                serde_json::from_value::<RuntimeInvocation>(wrong).is_err(),
                "installation {value:?} was accepted"
            );
        }
        // The runtime field is the closed four-value set.
        for value in ["pi-purge", "acp", "accp", "cursor-agent", "claude-code"] {
            let mut wrong = base.clone();
            wrong["runtime"] = serde_json::json!(value);
            assert!(
                serde_json::from_value::<RuntimeInvocation>(wrong).is_err(),
                "runtime {value} was accepted"
            );
        }
        // A CLI adapter field is not part of this contract.
        let mut adapter = base.clone();
        adapter["adapterKind"] = serde_json::json!("pi");
        assert!(serde_json::from_value::<RuntimeInvocation>(adapter).is_err());
        let mut unknown = base;
        unknown["installationPath"] = serde_json::json!("/usr/local/bin/pi");
        assert!(serde_json::from_value::<RuntimeInvocation>(unknown).is_err());

        // Generations are one-based, the version is exact, references are names.
        let mut zero = runtime_invocation();
        zero.installation_generation = 0;
        let zero_target = FrozenRunTarget::Runtime { invocation: zero };
        assert_eq!(zero_target.validate(), Err(DomainReject::Generation));
        let mut version = runtime_invocation();
        version.version = V2_DOMAIN_VERSION + 1;
        let version_target = FrozenRunTarget::Runtime {
            invocation: version,
        };
        assert_eq!(version_target.validate(), Err(DomainReject::Version));
        for bad in ["", "   ", "grant\u{7f}"] {
            let mut reference = runtime_invocation();
            reference.grant_ref = bad.to_string();
            let reference_target = FrozenRunTarget::Runtime {
                invocation: reference,
            };
            assert_eq!(
                reference_target.validate(),
                Err(DomainReject::Reference),
                "{bad:?} was accepted as a grant reference"
            );
        }
        let mut long = runtime_invocation();
        long.trace_id = "t".repeat(MAX_REF_BYTES + 1);
        let long_target = FrozenRunTarget::Runtime { invocation: long };
        assert_eq!(long_target.validate(), Err(DomainReject::Reference));
    }

    #[test]
    fn a_device_target_never_carries_a_runtime_installation() {
        let target: FrozenRunTarget =
            serde_json::from_value(device_json()).expect("device target parses");
        assert_eq!(target.validate(), Ok(()));
        assert!(target.device().is_some());
        assert!(target.runtime().is_none());
        let json = serde_json::to_string(&target).expect("serialize");
        assert!(json.contains("\"target\":\"device\""), "{json}");
        assert!(!json.contains("installationId"), "{json}");
        assert!(!json.contains("adapterKind"), "{json}");
        assert!(!json.contains("\"runtime\""), "{json}");
        assert_eq!(
            serde_json::from_str::<FrozenRunTarget>(&json).expect("parse"),
            target
        );

        // The core negative: a device-only target cannot smuggle a CLI
        // installation, an adapter or a bare run attempt into its own shape.
        for key in ["installationId", "adapterKind", "runtime", "runAttemptId"] {
            let mut smuggled = device_json();
            smuggled["invocation"][key] = serde_json::json!("install_pi_0851");
            assert!(
                serde_json::from_value::<FrozenRunTarget>(smuggled).is_err(),
                "{key} was accepted inside a device-only target"
            );
        }

        // A parent attempt is allowed only through the typed owner, and a unit
        // owner may not carry one.
        let mut owner = device_json();
        owner["invocation"]["owner"] =
            serde_json::json!({ "kind": "runAttempt", "runAttemptId": "attempt_1" });
        let with_attempt: FrozenRunTarget =
            serde_json::from_value(owner).expect("run attempt owner parses");
        assert_eq!(with_attempt.validate(), Ok(()));
        let mut missing_id = device_json();
        missing_id["invocation"]["owner"] = serde_json::json!({ "kind": "runAttempt" });
        assert!(serde_json::from_value::<FrozenRunTarget>(missing_id).is_err());
        let mut unknown_kind = device_json();
        unknown_kind["invocation"]["owner"] = serde_json::json!({ "kind": "runtime" });
        assert!(serde_json::from_value::<FrozenRunTarget>(unknown_kind).is_err());
        let mut unit_smuggles_attempt = device_json();
        unit_smuggles_attempt["invocation"]["owner"] =
            serde_json::json!({ "kind": "user", "runAttemptId": "attempt_1" });
        assert!(serde_json::from_value::<FrozenRunTarget>(unit_smuggles_attempt).is_err());

        // Required fields, one-based generation, exact version, references.
        let mut missing_generation = device_json();
        let _ = missing_generation["invocation"]
            .as_object_mut()
            .expect("object")
            .remove("connectionGeneration");
        assert!(serde_json::from_value::<FrozenRunTarget>(missing_generation).is_err());
        let mut missing_goal = device_json();
        let _ = missing_goal["invocation"]
            .as_object_mut()
            .expect("object")
            .remove("goalId");
        assert!(serde_json::from_value::<FrozenRunTarget>(missing_goal).is_err());
        let mut wrong_device = device_json();
        wrong_device["invocation"]["deviceId"] = serde_json::json!("install_pi_0851");
        assert!(serde_json::from_value::<FrozenRunTarget>(wrong_device).is_err());

        let mut zero = device_invocation();
        zero.connection_generation = 0;
        let zero_target = FrozenRunTarget::Device { invocation: zero };
        assert_eq!(zero_target.validate(), Err(DomainReject::Generation));
        let mut version = device_invocation();
        version.version = V2_DOMAIN_VERSION + 1;
        let version_target = FrozenRunTarget::Device {
            invocation: version,
        };
        assert_eq!(version_target.validate(), Err(DomainReject::Version));
        let mut reference = device_invocation();
        reference.workspace_ref = " ".to_string();
        let reference_target = FrozenRunTarget::Device {
            invocation: reference,
        };
        assert_eq!(reference_target.validate(), Err(DomainReject::Reference));
    }

    #[test]
    fn frozen_run_target_round_trips_and_refuses_unknown_fields() {
        for target in [
            FrozenRunTarget::Runtime {
                invocation: runtime_invocation(),
            },
            FrozenRunTarget::Device {
                invocation: device_invocation(),
            },
        ] {
            assert_eq!(target.validate(), Ok(()));
            let json = serde_json::to_string(&target).expect("serialize");
            assert_eq!(
                serde_json::from_str::<FrozenRunTarget>(&json).expect("parse"),
                target
            );
        }

        let base = device_json();
        // Unknown field next to the payload.
        let mut extra = base.clone();
        extra["extra"] = serde_json::json!(1);
        assert!(serde_json::from_value::<FrozenRunTarget>(extra).is_err());
        // Both payloads at once: the device variant has no runtime field.
        let mut both = base.clone();
        both["runtime"] = serde_json::to_value(runtime_invocation()).expect("value");
        assert!(serde_json::from_value::<FrozenRunTarget>(both).is_err());
        // Missing, mis-cased and invented tags.
        let mut missing = base.clone();
        let _ = missing.as_object_mut().expect("object").remove("target");
        assert!(serde_json::from_value::<FrozenRunTarget>(missing).is_err());
        for tag in ["Runtime", "Device", "deviceOnly", "device-only", ""] {
            let mut wrong = base.clone();
            wrong["target"] = serde_json::json!(tag);
            assert!(
                serde_json::from_value::<FrozenRunTarget>(wrong).is_err(),
                "tag {tag:?} was accepted"
            );
        }
        // The payload field name is part of the contract.
        let mut renamed = base;
        let payload = renamed
            .as_object_mut()
            .expect("object")
            .remove("invocation")
            .expect("payload");
        renamed["targetDevice"] = payload;
        assert!(serde_json::from_value::<FrozenRunTarget>(renamed).is_err());
    }
}
