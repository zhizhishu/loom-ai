//! Model-only sender identities. Stored authors remain the routing and authorization authority.
use std::collections::BTreeMap;

use anyhow::Result;
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MessageSender {
    sender_type: String,
    sender_id: String,
    // None omits the field (User/legacy); Some(None) emits null (unknown name).
    #[serde(skip_serializing_if = "Option::is_none")]
    sender_name: Option<Option<String>>,
}

impl MessageSender {
    pub(crate) fn legacy(author_type: &str, author_id: &str) -> Self {
        Self {
            sender_type: author_type.into(),
            sender_id: author_id.into(),
            sender_name: None,
        }
    }

    pub(crate) fn insert_into(&self, message: &mut Value) {
        let fields = serde_json::to_value(self).expect("sender fields serialize to JSON");
        message
            .as_object_mut()
            .expect("message projection is an object")
            .extend(fields.as_object().expect("sender is an object").clone());
    }
}

/// Request-local cache, including misses. Never filters authors by current membership.
#[derive(Default)]
pub(crate) struct SenderNames {
    names: BTreeMap<String, Option<String>>,
}

impl SenderNames {
    pub(crate) fn project(
        &mut self,
        connection: &Connection,
        author_type: &str,
        author_id: &str,
    ) -> Result<MessageSender> {
        Ok(match author_type {
            "user" | "external_principal" => MessageSender::legacy("user", "user"),
            "system" => MessageSender {
                sender_type: "system".into(),
                sender_id: "system".into(),
                sender_name: Some(None),
            },
            "agent" => {
                let name = match self.names.entry(author_id.into()) {
                    std::collections::btree_map::Entry::Occupied(entry) => entry.into_mut(),
                    std::collections::btree_map::Entry::Vacant(entry) => entry.insert(
                        connection
                            .query_row(
                                "SELECT display_name FROM agent_profile WHERE id = ?1",
                                [author_id],
                                |row| row.get::<_, Option<String>>(0),
                            )
                            .optional()?
                            .flatten()
                            .filter(|name| !name.trim().is_empty()),
                    ),
                };
                MessageSender {
                    sender_type: "agent".into(),
                    sender_id: author_id.into(),
                    sender_name: Some(name.clone()),
                }
            }
            _ => anyhow::bail!("Unsupported stored message author type: {author_type}"),
        })
    }
}
