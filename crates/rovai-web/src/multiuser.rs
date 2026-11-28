//! Boundary multi-user simulation for the Web Host.
//!
//! The Host runs one shared Core, so cloud users are separated only at this
//! network boundary: camp and agent ownership live in a private sidecar next
//! to the credential store, never in Core, and the sidecar deliberately holds
//! no tokens. When only the Owner identity exists (`enabled() == false`) every
//! gate and filter here is skipped and the Host behaves exactly as before.

use anyhow::{Context, Result, ensure};
use rovai_core::platform::{atomic_write_private_bytes, open_private_read_file};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::Read,
    path::{Path, PathBuf},
    sync::Mutex,
};

use crate::{auth::valid_cloud_user_id, operations::Operation};

const STORE_FILE: &str = "cloud-multiuser.json";
const MAX_STORE_BYTES: usize = 1024 * 1024;
const MAX_RECORD_ID_BYTES: usize = 128;
/// Core's current notification projection schema, kept in sync by hand so the
/// empty multi-user projections stay shape-compatible without forwarding.
const NOTIFICATION_SCHEMA_VERSION: i64 = 11;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredMultiuser {
    version: u32,
    #[serde(default)]
    camps: HashMap<String, StoredCampOwnership>,
    #[serde(default)]
    agents: HashMap<String, StoredAgentOwnership>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredCampOwnership {
    owner_user_id: String,
    #[serde(default)]
    member_user_ids: Vec<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredAgentOwnership {
    owner_user_id: String,
}

#[derive(Default)]
struct MultiuserState {
    camps: HashMap<String, CampOwnership>,
    agents: HashMap<String, String>,
}

struct CampOwnership {
    owner_user_id: String,
    member_user_ids: Vec<String>,
}

pub struct Multiuser {
    path: Option<PathBuf>,
    user_count: usize,
    state: Mutex<MultiuserState>,
}

/// One admission decision for `/api/v1/request` in multi-user mode.
pub enum Gate {
    Allow,
    /// Unified small denial: an unknown scope and a forbidden one are
    /// indistinguishable, and the request is never forwarded to Core.
    Deny,
    /// Serve a synthetic projection without forwarding to Core.
    Respond(Value),
}

pub enum AddMember {
    NotFound,
    Denied,
    Added { member_user_ids: Vec<String> },
}

impl Multiuser {
    /// Opens the sidecar ownership store. A missing file is an empty store; a
    /// damaged file fails closed so the boundary never guesses ownership.
    pub fn open(data_dir: &Path, user_count: usize) -> Result<Self> {
        let path = data_dir.join(STORE_FILE);
        let state = read_store(&path)?.unwrap_or_default();
        Ok(Self {
            path: Some(path),
            user_count,
            state: Mutex::new(state),
        })
    }

    #[cfg(test)]
    fn in_memory(user_count: usize) -> Self {
        Self {
            path: None,
            user_count,
            state: Mutex::new(MultiuserState::default()),
        }
    }

    /// The boundary simulation is active only when more than one cloud
    /// identity exists; a single-user Host keeps its original behavior.
    pub fn enabled(&self) -> bool {
        self.user_count > 1
    }

    /// A camp is visible to its owner and to every member user of the camp.
    /// An unrecorded camp is visible to no one (fail closed).
    pub fn camp_visible(&self, user: &str, camp_id: &str) -> bool {
        let state = self.state.lock().expect("cloud multi-user state poisoned");
        state.camps.get(camp_id).is_some_and(|camp| {
            camp.owner_user_id == user || camp.member_user_ids.iter().any(|id| id == user)
        })
    }

    /// An agent is visible to its owning user only; an unrecorded agent is
    /// visible to no one (fail closed).
    pub fn agent_owned(&self, user: &str, agent_id: &str) -> bool {
        let state = self.state.lock().expect("cloud multi-user state poisoned");
        state
            .agents
            .get(agent_id)
            .is_some_and(|owner| owner == user)
    }

    /// Member user list of one camp, but only for a user who can see it.
    pub fn visible_camp_members(&self, user: &str, camp_id: &str) -> Option<Vec<String>> {
        let state = self.state.lock().expect("cloud multi-user state poisoned");
        let camp = state.camps.get(camp_id)?;
        (camp.owner_user_id == user || camp.member_user_ids.iter().any(|id| id == user))
            .then(|| camp.member_user_ids.clone())
    }

    /// Records the owner of a newly created camp. The creator is the owner and
    /// the first (and initially only) member.
    pub fn record_camp(&self, camp_id: &str, owner_user_id: &str) -> Result<()> {
        let mut state = self.state.lock().expect("cloud multi-user state poisoned");
        if state.camps.contains_key(camp_id) {
            return Ok(());
        }
        state.camps.insert(
            camp_id.to_owned(),
            CampOwnership {
                owner_user_id: owner_user_id.to_owned(),
                member_user_ids: vec![owner_user_id.to_owned()],
            },
        );
        self.persist(&state)
    }

    /// Records the owner of a newly created agent.
    pub fn record_agent(&self, agent_id: &str, owner_user_id: &str) -> Result<()> {
        let mut state = self.state.lock().expect("cloud multi-user state poisoned");
        if state.agents.contains_key(agent_id) {
            return Ok(());
        }
        state
            .agents
            .insert(agent_id.to_owned(), owner_user_id.to_owned());
        self.persist(&state)
    }

    /// Adds one cloud user to a camp. Only the camp's owner may add; unknown
    /// camps and foreign actors get small denials instead of distinctions.
    /// Adding an existing member is idempotent.
    pub fn add_camp_member(
        &self,
        camp_id: &str,
        acting_user: &str,
        member_user_id: &str,
    ) -> Result<AddMember> {
        let mut state = self.state.lock().expect("cloud multi-user state poisoned");
        let Some(camp) = state.camps.get_mut(camp_id) else {
            return Ok(AddMember::NotFound);
        };
        if camp.owner_user_id != acting_user {
            return Ok(AddMember::Denied);
        }
        if !camp.member_user_ids.iter().any(|id| id == member_user_id) {
            camp.member_user_ids.push(member_user_id.to_owned());
            self.persist(&state)?;
        }
        let member_user_ids = state
            .camps
            .get(camp_id)
            .map(|camp| camp.member_user_ids.clone())
            .unwrap_or_default();
        Ok(AddMember::Added { member_user_ids })
    }

    /// Records ownership for the two creation operations of the acceptance
    /// chain from Core's raw command result.
    pub fn record_creations(
        &self,
        user: &str,
        operation: &Operation,
        result: Option<&Value>,
    ) -> Result<()> {
        let Some(result) = result else {
            return Ok(());
        };
        let payload = &result["payload"];
        match operation {
            Operation::CampCreate => {
                if let Some(camp_id) = payload["threadId"].as_str() {
                    self.record_camp(camp_id, user)?;
                }
            }
            Operation::MemberCreate => {
                let agent_id = payload["agentId"]
                    .as_str()
                    .or_else(|| payload["profile"]["agentId"].as_str());
                if let Some(agent_id) = agent_id {
                    self.record_agent(agent_id, user)?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// Minimal admission for one authenticated operation. Camp-scoped calls
    /// require a visible camp, agent-scoped calls require an owned agent, and
    /// Core's single-user notifications are replaced by empty projections.
    /// Operations outside the acceptance chain stay admitted unchanged.
    pub fn gate(&self, user: &str, operation: &Operation, params: &Value) -> Gate {
        match operation {
            Operation::CampOpen
            | Operation::CampEnter
            | Operation::Messages
            | Operation::Send
            | Operation::CampRename
            | Operation::CampSetHidden
            | Operation::CampDelete
            | Operation::CampExists
            | Operation::CampMemberTimeline
            | Operation::MessagesAround
            | Operation::Replies
            | Operation::UserAnchors
            | Operation::FindMessages => {
                // A missing id is denied as well; Core never sees the request.
                if camp_scope(params).is_some_and(|camp| self.camp_visible(user, camp)) {
                    Gate::Allow
                } else {
                    Gate::Deny
                }
            }
            Operation::Member
            | Operation::MemberUpdate
            | Operation::MemberAvatar
            | Operation::MemberRuntime
            | Operation::MemberClearRuntime
            | Operation::MemberRemovalPreview
            | Operation::MemberRemove
            | Operation::MemberCapabilityGet
            | Operation::MemberCapabilitySet
            | Operation::MemberExecutionGet
            | Operation::MemberExecutionSave
            | Operation::MemberRunProjection
            | Operation::MemberEnvironmentGet => {
                if agent_scope(params).is_some_and(|agent| self.agent_owned(user, agent)) {
                    Gate::Allow
                } else {
                    Gate::Deny
                }
            }
            Operation::SingleChatOpen => {
                // The conversation belongs to one agent inside one camp: the
                // requester must own the agent and see the camp.
                let visible = camp_scope(params).is_some_and(|camp| self.camp_visible(user, camp));
                let owned = agent_scope(params).is_some_and(|agent| self.agent_owned(user, agent));
                if visible && owned {
                    Gate::Allow
                } else {
                    Gate::Deny
                }
            }
            Operation::SingleChatSend => {
                if camp_scope(params).is_some_and(|camp| self.camp_visible(user, camp)) {
                    Gate::Allow
                } else {
                    Gate::Deny
                }
            }
            Operation::NotificationInbox => Gate::Respond(json!({
                "schemaVersion": NOTIFICATION_SCHEMA_VERSION,
                "throughChangeSequence": 0,
                "unreadCount": 0,
                "items": [],
                "nextCursor": null
            })),
            Operation::NotificationChanges => {
                let after = params["afterChangeSequence"].as_i64().unwrap_or(0);
                Gate::Respond(json!({
                    "schemaVersion": NOTIFICATION_SCHEMA_VERSION,
                    "requestedAfterChangeSequence": after,
                    "nextChangeSequence": 0,
                    "throughChangeSequence": 0,
                    "taskCapability": {
                        "enabled": false,
                        "headsUpAfterSequence": 0,
                        "observedThroughChangeSequence": 0
                    },
                    "resetRequired": true,
                    "hasMore": false,
                    "changes": []
                }))
            }
            Operation::NotificationThreadInterruptions => Gate::Respond(json!({
                "throughChangeSequence": 0,
                "threads": []
            })),
            Operation::NotificationPreference => Gate::Respond(json!({
                "headsUpEnabled": false,
                "approvalHeadsUpEnabled": false,
                "userMentionHeadsUpEnabled": false,
                "turnCompletedHeadsUpEnabled": false,
                "turnIncompleteHeadsUpEnabled": false,
                "singleChatHeadsUpEnabled": false,
                "missionNeedsYouHeadsUpEnabled": false,
                "missionStatusHeadsUpEnabled": false,
                "taskStatusHeadsUpEnabled": false,
                "missionStatuses": [],
                "taskStatuses": [],
                "version": 0,
                "updatedAt": ""
            })),
            Operation::NotificationAcknowledge
            | Operation::NotificationAcknowledgeInterruptions
            | Operation::NotificationPreferenceUpdate
            | Operation::NotificationVisible => Gate::Respond(json!({
                "status": "applied",
                "code": "multiuser.notifications_unavailable",
                "payload": {}
            })),
            _ => Gate::Allow,
        }
    }

    /// Filters one Core response for the requesting user. Returns false when
    /// the whole response must be withheld.
    pub fn filter_response(&self, user: &str, operation: &Operation, result: &mut Value) -> bool {
        match operation {
            Operation::Navigation => {
                if let Some(group) = result.get_mut("quickChat") {
                    self.filter_thread_group(user, group);
                }
                if let Some(projects) = result.get_mut("projects").and_then(Value::as_array_mut) {
                    for project in projects {
                        self.filter_thread_group(user, project);
                    }
                }
            }
            Operation::NavigationCamps => self.filter_thread_rows(user, result),
            Operation::GroupCamps => self.filter_thread_page(user, result),
            Operation::CampHiddenList => {
                if let Some(camps) = result.as_array_mut() {
                    camps.retain(|camp| {
                        camp["id"]
                            .as_str()
                            .is_some_and(|id| self.camp_visible(user, id))
                    });
                }
            }
            Operation::Members => {
                if let Some(agents) = result.as_array_mut() {
                    agents.retain(|agent| {
                        agent["agentId"]
                            .as_str()
                            .is_some_and(|id| self.agent_owned(user, id))
                    });
                }
            }
            Operation::SingleChatList => {
                if let Some(conversations) = result.as_array_mut() {
                    conversations.retain(|conversation| {
                        conversation["agentId"]
                            .as_str()
                            .is_some_and(|id| self.agent_owned(user, id))
                    });
                }
            }
            Operation::SingleChatGet => {
                // Withhold the whole snapshot unless it belongs to the user's
                // own agent; an unexpected shape is also withheld.
                return result["conversation"]["agentId"]
                    .as_str()
                    .is_some_and(|id| self.agent_owned(user, id));
            }
            _ => {}
        }
        true
    }

    /// One navigation group: drop invisible threads and recount when the page
    /// shrank, so a group only counts what this user can see.
    fn filter_thread_group(&self, user: &str, group: &mut Value) {
        for key in ["recentThreads", "recentCamps"] {
            let dropped = match group.get_mut(key).and_then(Value::as_array_mut) {
                Some(threads) => {
                    let before = threads.len();
                    threads.retain(|thread| {
                        thread["id"]
                            .as_str()
                            .is_some_and(|camp| self.camp_visible(user, camp))
                    });
                    before != threads.len()
                }
                None => false,
            };
            if dropped {
                let visible = group[key].as_array().map_or(0, |threads| threads.len());
                group["totalCount"] = json!(visible);
            }
        }
    }

    /// One camp page: same drop, plus the page stops promising a next offset
    /// once entries disappeared from it.
    fn filter_thread_page(&self, user: &str, page: &mut Value) {
        for key in ["threads", "camps"] {
            let dropped = match page.get_mut(key).and_then(Value::as_array_mut) {
                Some(threads) => {
                    let before = threads.len();
                    threads.retain(|thread| {
                        thread["id"]
                            .as_str()
                            .is_some_and(|camp| self.camp_visible(user, camp))
                    });
                    before != threads.len()
                }
                None => false,
            };
            if dropped {
                let visible = page[key].as_array().map_or(0, |threads| threads.len());
                page["totalCount"] = json!(visible);
                if let Some(object) = page.as_object_mut() {
                    object.insert("nextOffset".into(), Value::Null);
                }
            }
        }
    }

    /// One explicit camp-rows projection: drop invisible rows.
    fn filter_thread_rows(&self, user: &str, rows: &mut Value) {
        for key in ["threads", "camps"] {
            if let Some(threads) = rows.get_mut(key).and_then(Value::as_array_mut) {
                threads.retain(|thread| {
                    thread["id"]
                        .as_str()
                        .is_some_and(|camp| self.camp_visible(user, camp))
                });
            }
        }
    }

    fn persist(&self, state: &MultiuserState) -> Result<()> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        let stored = StoredMultiuser {
            version: 1,
            camps: state
                .camps
                .iter()
                .map(|(camp_id, camp)| {
                    (
                        camp_id.clone(),
                        StoredCampOwnership {
                            owner_user_id: camp.owner_user_id.clone(),
                            member_user_ids: camp.member_user_ids.clone(),
                        },
                    )
                })
                .collect(),
            agents: state
                .agents
                .iter()
                .map(|(agent_id, owner)| {
                    (
                        agent_id.clone(),
                        StoredAgentOwnership {
                            owner_user_id: owner.clone(),
                        },
                    )
                })
                .collect(),
        };
        let bytes = serde_json::to_vec(&stored).context("cloud multi-user store is invalid")?;
        atomic_write_private_bytes(path, &bytes)
            .map_err(|error| error.context("cloud multi-user store cannot be saved"))
    }
}

fn read_store(path: &Path) -> Result<Option<MultiuserState>> {
    // Same admission policy as the credential store: a link or a non-regular
    // object is never treated as an empty store.
    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(anyhow::Error::from(error).context("cloud multi-user store is unavailable"));
        }
        Ok(metadata) => ensure!(
            metadata.is_file() && !metadata.file_type().is_symlink(),
            "cloud multi-user store path is invalid"
        ),
    }
    let mut bytes = Vec::new();
    open_private_read_file(path)?
        .take(MAX_STORE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .context("cloud multi-user store is unavailable")?;
    ensure!(
        bytes.len() <= MAX_STORE_BYTES,
        "cloud multi-user store exceeds the size limit"
    );
    // A damaged store fails closed: ownership must never be guessed.
    let stored: StoredMultiuser =
        serde_json::from_slice(&bytes).context("cloud multi-user store is invalid")?;
    ensure!(
        stored.version == 1,
        "cloud multi-user store version is unsupported"
    );
    let mut camps = HashMap::new();
    for (camp_id, camp) in stored.camps {
        ensure!(
            valid_record_id(&camp_id) && valid_cloud_user_id(&camp.owner_user_id),
            "cloud multi-user store is invalid"
        );
        let mut member_user_ids = Vec::new();
        for member in camp.member_user_ids {
            ensure!(
                valid_cloud_user_id(&member),
                "cloud multi-user store is invalid"
            );
            if !member_user_ids.contains(&member) {
                member_user_ids.push(member);
            }
        }
        camps.insert(
            camp_id,
            CampOwnership {
                owner_user_id: camp.owner_user_id,
                member_user_ids,
            },
        );
    }
    let mut agents = HashMap::new();
    for (agent_id, agent) in stored.agents {
        ensure!(
            valid_record_id(&agent_id) && valid_cloud_user_id(&agent.owner_user_id),
            "cloud multi-user store is invalid"
        );
        agents.insert(agent_id, agent.owner_user_id);
    }
    Ok(Some(MultiuserState { camps, agents }))
}

fn valid_record_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_RECORD_ID_BYTES
        && id.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
}

fn id_at<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
}

/// Camp ids travel at the top of params or inside `command`, under the
/// `threadId`/`campId` aliases of Core's shared params structs.
fn camp_scope(params: &Value) -> Option<&str> {
    id_at(params, &["threadId", "campId"])
        .or_else(|| id_at(&params["command"], &["threadId", "campId"]))
}

/// Agent ids travel as `agentId`, `memberId` or `member`, at the top of
/// params or inside `command`.
fn agent_scope(params: &Value) -> Option<&str> {
    id_at(params, &["agentId", "memberId", "member"])
        .or_else(|| id_at(&params["command"], &["agentId", "memberId", "member"]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn operation(name: &str) -> Operation {
        serde_json::from_value(json!(name)).unwrap()
    }

    // Owns the ownership model: who can see which camp, who owns which agent,
    // and that only the camp owner may extend the member list.
    #[test]
    fn visibility_and_membership_follow_sidecar_ownership() {
        let store = Multiuser::in_memory(2);
        assert!(store.enabled());
        store.record_camp("camp-a", "owner").unwrap();
        store.record_agent("agent-a", "owner").unwrap();
        assert!(store.camp_visible("owner", "camp-a"));
        assert!(!store.camp_visible("boba", "camp-a"));
        assert!(!store.camp_visible("owner", "camp-b"));
        assert!(store.agent_owned("owner", "agent-a"));
        assert!(!store.agent_owned("boba", "agent-a"));
        assert!(!store.agent_owned("owner", "agent-b"));
        // The owner adds boba; membership makes the camp visible to her.
        assert!(matches!(
            store.add_camp_member("camp-a", "owner", "boba").unwrap(),
            AddMember::Added { member_user_ids } if member_user_ids == ["owner", "boba"]
        ));
        assert!(store.camp_visible("boba", "camp-a"));
        assert_eq!(
            store.visible_camp_members("boba", "camp-a").unwrap(),
            ["owner", "boba"]
        );
        assert!(store.visible_camp_members("boba", "camp-b").is_none());
        // Only the camp owner may add members; unknown camps stay deniable.
        assert!(matches!(
            store.add_camp_member("camp-a", "boba", "owner").unwrap(),
            AddMember::Denied
        ));
        assert!(matches!(
            store.add_camp_member("camp-b", "owner", "boba").unwrap(),
            AddMember::NotFound
        ));
        // Adding an existing member is idempotent.
        assert!(matches!(
            store.add_camp_member("camp-a", "owner", "boba").unwrap(),
            AddMember::Added { member_user_ids } if member_user_ids == ["owner", "boba"]
        ));
        // A single-user Host never enables the boundary.
        assert!(!Multiuser::in_memory(1).enabled());
        assert!(!Multiuser::in_memory(0).enabled());
    }

    // Owns the sidecar durability: records survive a reopen, a missing file is
    // an empty store, and a damaged file fails closed.
    #[test]
    fn sidecar_persists_reopens_and_fails_closed_on_corruption() {
        let root =
            std::env::temp_dir().join(format!("rovai-multiuser-{}", crate::new_token().unwrap()));
        std::fs::create_dir_all(&root).unwrap();
        let store = Multiuser::open(&root, 2).unwrap();
        store.record_camp("camp-a", "owner").unwrap();
        store.record_agent("agent-a", "boba").unwrap();
        store.add_camp_member("camp-a", "owner", "boba").unwrap();
        drop(store);
        let reopened = Multiuser::open(&root, 1).unwrap();
        assert!(!reopened.enabled());
        assert!(reopened.camp_visible("boba", "camp-a"));
        assert!(reopened.agent_owned("boba", "agent-a"));
        assert_eq!(
            reopened.visible_camp_members("boba", "camp-a").unwrap(),
            ["owner", "boba"]
        );
        // The sidecar carries no token material.
        let raw = std::fs::read_to_string(root.join(STORE_FILE)).unwrap();
        assert!(!raw.contains("token"));
        assert!(!raw.contains("Token"));
        drop(reopened);
        // A damaged store fails closed instead of reopening empty.
        std::fs::write(root.join(STORE_FILE), b"{broken").unwrap();
        assert!(Multiuser::open(&root, 2).is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }

    // Owns the request gate: camp- and agent-scoped admission plus the empty
    // notification projections of multi-user mode.
    #[test]
    fn gate_denies_invisible_scopes_and_redirects_notifications() {
        let store = Multiuser::in_memory(2);
        store.record_camp("camp-a", "owner").unwrap();
        store.record_agent("agent-a", "owner").unwrap();
        // The owner sees her own camp.
        assert!(matches!(
            store.gate(
                "owner",
                &operation("camps.open"),
                &json!({"threadId": "camp-a"})
            ),
            Gate::Allow
        ));
        // A missing id, an unknown camp and a foreign camp are the same denial.
        for params in [
            json!({"threadId": "camp-b"}),
            json!({}),
            json!({"campId": "camp-a"}),
        ] {
            assert!(
                matches!(
                    store.gate("boba", &operation("camps.open"), &params),
                    Gate::Deny
                ),
                "{params}"
            );
        }
        // Command-scoped ids are honored (camps.enter sends command.threadId).
        assert!(matches!(
            store.gate(
                "boba",
                &operation("camps.enter"),
                &json!({"command": {"threadId": "camp-a"}})
            ),
            Gate::Deny
        ));
        store.add_camp_member("camp-a", "owner", "boba").unwrap();
        assert!(matches!(
            store.gate(
                "boba",
                &operation("camps.enter"),
                &json!({"command": {"threadId": "camp-a"}})
            ),
            Gate::Allow
        ));
        assert!(matches!(
            store.gate(
                "boba",
                &operation("camp.messages.send"),
                &json!({"threadId": "camp-a"})
            ),
            Gate::Allow
        ));
        // Agent-scoped operations are owner-only.
        assert!(matches!(
            store.gate(
                "owner",
                &operation("members.get"),
                &json!({"agentId": "agent-a"})
            ),
            Gate::Allow
        ));
        assert!(matches!(
            store.gate(
                "boba",
                &operation("members.get"),
                &json!({"agentId": "agent-a"})
            ),
            Gate::Deny
        ));
        assert!(matches!(
            store.gate(
                "boba",
                &operation("members.runtime.set"),
                &json!({"command": {"agentId": "agent-a"}})
            ),
            Gate::Deny
        ));
        assert!(matches!(
            store.gate(
                "owner",
                &operation("members.executionTarget.get"),
                &json!({"memberId": "agent-a"})
            ),
            Gate::Allow
        ));
        assert!(matches!(
            store.gate(
                "owner",
                &operation("members.runProjection.preview"),
                &json!({"member": "agent-a"})
            ),
            Gate::Allow
        ));
        // Single chat needs an owned agent inside a visible camp.
        assert!(matches!(
            store.gate(
                "boba",
                &operation("singleChat.open"),
                &json!({"command": {"threadId": "camp-a", "agentId": "agent-a"}})
            ),
            Gate::Deny
        ));
        assert!(matches!(
            store.gate(
                "boba",
                &operation("singleChat.send"),
                &json!({"command": {"threadId": "camp-a"}})
            ),
            Gate::Allow
        ));
        // Notifications answer with empty projections, never Core data.
        match store.gate("boba", &operation("notifications.inbox"), &json!({})) {
            Gate::Respond(value) => {
                assert_eq!(value["items"], json!([]));
                assert_eq!(value["unreadCount"], 0);
                assert_eq!(value["nextCursor"], json!(null));
            }
            _ => panic!("notifications.inbox must respond with an empty projection"),
        }
        match store.gate(
            "boba",
            &operation("notifications.changesSince"),
            &json!({"afterChangeSequence": 7}),
        ) {
            Gate::Respond(value) => {
                assert_eq!(value["requestedAfterChangeSequence"], 7);
                assert_eq!(value["changes"], json!([]));
                assert_eq!(value["resetRequired"], true);
            }
            _ => panic!("notifications.changesSince must respond with an empty projection"),
        }
        assert!(matches!(
            store.gate(
                "boba",
                &operation("notifications.threadInterruptions"),
                &json!({"threadIds": []})
            ),
            Gate::Respond(_)
        ));
        assert!(matches!(
            store.gate(
                "boba",
                &operation("notifications.acknowledge"),
                &json!({"command": {}})
            ),
            Gate::Respond(_)
        ));
        assert!(matches!(
            store.gate(
                "boba",
                &operation("notifications.preference.get"),
                &json!({})
            ),
            Gate::Respond(_)
        ));
        assert!(matches!(
            store.gate(
                "boba",
                &operation("notifications.preference.update"),
                &json!({"command": {}})
            ),
            Gate::Respond(_)
        ));
        // Unlisted operations keep flowing unchanged.
        assert!(matches!(
            store.gate("boba", &operation("health.check"), &json!({})),
            Gate::Allow
        ));
        assert!(matches!(
            store.gate("boba", &operation("camps.create"), &json!({})),
            Gate::Allow
        ));
    }

    // Owns the response filters and creation recording of the acceptance chain.
    #[test]
    fn response_filters_keep_visible_camps_and_owned_agents() {
        let store = Multiuser::in_memory(2);
        store.record_camp("camp-a", "owner").unwrap();
        store.record_agent("agent-a", "owner").unwrap();
        // Navigation snapshot: invisible camps vanish and groups recount.
        let mut snapshot = json!({
            "schemaVersion": 3,
            "quickChat": {"totalCount": 2, "recentThreads": [
                {"id": "camp-a", "title": "A"}, {"id": "camp-b", "title": "B"}]},
            "projects": [{"projectKey": "p", "totalCount": 2, "recentThreads": [
                {"id": "camp-a"}, {"id": "camp-b"}]}]
        });
        assert!(store.filter_response("boba", &operation("navigation.snapshot"), &mut snapshot));
        assert_eq!(snapshot["quickChat"]["recentThreads"], json!([]));
        assert_eq!(snapshot["quickChat"]["totalCount"], 0);
        assert_eq!(snapshot["projects"][0]["recentThreads"], json!([]));
        assert_eq!(snapshot["projects"][0]["totalCount"], 0);
        // The owner keeps her own camp; the shrunken group recounts for her too.
        let mut owner_snapshot = json!({
            "schemaVersion": 3,
            "quickChat": {"totalCount": 2, "recentThreads": [
                {"id": "camp-a"}, {"id": "camp-b"}]}
        });
        store.filter_response(
            "owner",
            &operation("navigation.snapshot"),
            &mut owner_snapshot,
        );
        assert_eq!(
            owner_snapshot["quickChat"]["recentThreads"],
            json!([{"id": "camp-a"}])
        );
        assert_eq!(owner_snapshot["quickChat"]["totalCount"], 1);
        // Camp rows keep only visible entries.
        let mut rows = json!({"groupKeys": ["quick-chat"], "threads": [
            {"id": "camp-a"}, {"id": "camp-b"}]});
        store.filter_response("boba", &operation("navigation.camps"), &mut rows);
        assert_eq!(rows["threads"], json!([]));
        let mut owner_rows = json!({"groupKeys": ["quick-chat"], "threads": [
            {"id": "camp-a"}, {"id": "camp-b"}]});
        store.filter_response("owner", &operation("navigation.camps"), &mut owner_rows);
        assert_eq!(owner_rows["threads"], json!([{"id": "camp-a"}]));
        // A camp page that shrank stops promising a next offset.
        let mut page = json!({"totalCount": 2, "nextOffset": 2, "threads": [
            {"id": "camp-a"}, {"id": "camp-b"}]});
        store.filter_response("owner", &operation("navigation.groupCamps"), &mut page);
        assert_eq!(page["threads"], json!([{"id": "camp-a"}]));
        assert_eq!(page["totalCount"], 1);
        assert_eq!(page["nextOffset"], json!(null));
        // Hidden camps keep only visible camps.
        let mut hidden = json!([{"id": "camp-a"}, {"id": "camp-b"}]);
        store.filter_response("owner", &operation("camps.hiddenList"), &mut hidden);
        assert_eq!(hidden, json!([{"id": "camp-a"}]));
        // The member roster keeps only owned agents (owner-only fallback).
        let mut roster = json!([{"agentId": "agent-a"}, {"agentId": "agent-b"}]);
        store.filter_response("owner", &operation("members.list"), &mut roster);
        assert_eq!(roster, json!([{"agentId": "agent-a"}]));
        let mut boba_roster = json!([{"agentId": "agent-a"}]);
        store.filter_response("boba", &operation("members.list"), &mut boba_roster);
        assert_eq!(boba_roster, json!([]));
        // Single chat lists filter by agent ownership.
        let mut chats = json!([
            {"id": "c1", "agentId": "agent-a"},
            {"id": "c2", "agentId": "agent-b"}
        ]);
        store.filter_response("owner", &operation("singleChat.list"), &mut chats);
        assert_eq!(chats, json!([{"id": "c1", "agentId": "agent-a"}]));
        // A foreign agent's single chat snapshot is withheld entirely.
        let mut foreign =
            json!({"conversation": {"id": "c2", "agentId": "agent-b"}, "messages": []});
        assert!(!store.filter_response("owner", &operation("singleChat.get"), &mut foreign));
        let mut own = json!({"conversation": {"id": "c1", "agentId": "agent-a"}, "messages": []});
        assert!(store.filter_response("owner", &operation("singleChat.get"), &mut own));
        // Creation recording reads both known payload shapes.
        let camps_created = json!({"status": "applied", "payload": {"threadId": "camp-c"}});
        store
            .record_creations("owner", &operation("camps.create"), Some(&camps_created))
            .unwrap();
        assert!(store.camp_visible("owner", "camp-c"));
        let agents_created = json!({"status": "applied", "payload": {"agentId": "agent-c"}});
        store
            .record_creations("boba", &operation("members.create"), Some(&agents_created))
            .unwrap();
        assert!(store.agent_owned("boba", "agent-c"));
        let profile_shape =
            json!({"status": "applied", "payload": {"profile": {"agentId": "agent-d"}}});
        store
            .record_creations("boba", &operation("members.create"), Some(&profile_shape))
            .unwrap();
        assert!(store.agent_owned("boba", "agent-d"));
        assert_eq!(
            store.visible_camp_members("owner", "camp-c").unwrap(),
            ["owner"]
        );
    }
}
