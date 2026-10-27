//! Shared creation choices. Legacy Custom values are imported without creating a Team.
use crate::{
    db::Database,
    teams::{Roster, get_on_connection},
};
use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{io::Read, path::Path};

#[derive(Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub new_conversation_defaults: Option<Roster>,
    #[serde(default)]
    pub new_conversation_team_id: Option<String>,
    pub new_conversation_defaults_require_confirmation: bool,
    pub one_click_new_conversation_enabled: bool,
}

impl Snapshot {
    fn validate(&self) -> Result<()> {
        if let Some(roster) = &self.new_conversation_defaults {
            roster.validate()?;
        }
        if let Some(id) = &self.new_conversation_team_id {
            anyhow::ensure!(
                !id.is_empty() && id.chars().count() <= 200,
                "Invalid default Team"
            );
        } else if self.new_conversation_defaults.is_none() {
            anyhow::ensure!(
                !self.one_click_new_conversation_enabled
                    && !self.new_conversation_defaults_require_confirmation,
                "Custom members are missing"
            );
        }
        Ok(())
    }

    fn selected_available(&self, connection: &Connection) -> Result<bool> {
        let roster = match &self.new_conversation_team_id {
            Some(id) => get_on_connection(connection, id)?.map(|team| team.roster),
            None => self.new_conversation_defaults.clone(),
        };
        match roster {
            Some(roster) => roster.available(connection),
            None => Ok(false),
        }
    }
}

fn read(connection: &Connection) -> Result<Option<Snapshot>> {
    let json: Option<String> = connection
        .query_row(
            "SELECT state_json FROM creation_preferences WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    json.map(|text| Ok(serde_json::from_str(&text)?))
        .transpose()
}

fn write(connection: &Connection, snapshot: &Snapshot) -> Result<()> {
    connection.execute(
        "INSERT INTO creation_preferences(singleton,state_json) VALUES(1,?1)
        ON CONFLICT(singleton) DO UPDATE SET state_json=excluded.state_json",
        [serde_json::to_string(snapshot)?],
    )?;
    Ok(())
}

pub(crate) fn clear_deleted_team(connection: &Connection, id: &str) -> Result<()> {
    if let Some(mut saved) = read(connection)?
        && saved.new_conversation_team_id.as_deref() == Some(id)
    {
        saved.new_conversation_team_id = None;
        saved.one_click_new_conversation_enabled = false;
        saved.new_conversation_defaults_require_confirmation = false;
        write(connection, &saved)?;
    }
    Ok(())
}

pub fn execute(
    root: &Path,
    database: &mut Database,
    method: &str,
    params: Value,
) -> Result<(Value, bool)> {
    let tx = database.connection_mut().transaction()?;
    let mut saved = read(&tx)?;
    // The old file remains untouched for recovery. Once the row exists it is never reread.
    if saved.is_none() {
        match std::fs::File::open(root.join("new-conversation-preferences.json")) {
            Ok(file) => {
                let mut bytes = Vec::new();
                file.take(65_537).read_to_end(&mut bytes)?;
                anyhow::ensure!(
                    bytes.len() <= 65_536,
                    "Creation preferences exceed the size limit"
                );
                let mut legacy: Snapshot = serde_json::from_slice(&bytes)?;
                legacy.new_conversation_team_id = None;
                legacy.validate()?;
                write(&tx, &legacy)?;
                saved = Some(legacy);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(error.into()),
        }
    }
    let mut next = saved.clone().unwrap_or_default();
    match method {
        "preferences.newConversation.get" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Empty {}
            let _: Empty = serde_json::from_value(params)?;
            let value = serde_json::to_value(next)?;
            tx.commit()?;
            return Ok((value, false));
        }
        "preferences.newConversation.initialize" => {
            let mut legacy: Snapshot = serde_json::from_value(params)?;
            legacy.new_conversation_team_id = None;
            legacy.validate()?;
            if saved.is_none() {
                next = legacy;
            }
        }
        "preferences.newConversation.setDefaults" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Set {
                defaults: Roster,
                enable_one_click: bool,
            }
            let input: Set = serde_json::from_value(params)?;
            input.defaults.validate()?;
            anyhow::ensure!(
                input.defaults.available(&tx)?,
                "Custom members are unavailable"
            );
            next.new_conversation_defaults = Some(input.defaults);
            next.new_conversation_team_id = None;
            next.new_conversation_defaults_require_confirmation = false;
            next.one_click_new_conversation_enabled |= input.enable_one_click;
        }
        "preferences.newConversation.setTeam" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Set {
                team_id: Option<String>,
                #[serde(default)]
                enable_one_click: bool,
            }
            let input: Set = serde_json::from_value(params)?;
            if let Some(id) = &input.team_id {
                let team = get_on_connection(&tx, id)?.context("Team is unavailable")?;
                anyhow::ensure!(team.roster.available(&tx)?, "Team members are unavailable");
            }
            next.new_conversation_team_id = input.team_id;
            next.new_conversation_defaults_require_confirmation = false;
            let available = next.selected_available(&tx)?;
            anyhow::ensure!(
                !input.enable_one_click || available,
                "Default members are unavailable"
            );
            next.one_click_new_conversation_enabled =
                available && (next.one_click_new_conversation_enabled || input.enable_one_click);
        }
        "preferences.newConversation.setOneClick" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Set {
                enabled: bool,
            }
            let input: Set = serde_json::from_value(params)?;
            if input.enabled {
                anyhow::ensure!(
                    !next.new_conversation_defaults_require_confirmation
                        && next.selected_available(&tx)?,
                    "Default members require confirmation"
                );
            }
            next.one_click_new_conversation_enabled = input.enabled;
        }
        "preferences.newConversation.invalidate" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Invalidate {
                expected_defaults: Option<Roster>,
                #[serde(default)]
                expected_team_id: Option<String>,
            }
            let input: Invalidate = serde_json::from_value(params)?;
            if next.new_conversation_defaults == input.expected_defaults
                && next.new_conversation_team_id == input.expected_team_id
                && (next.new_conversation_defaults.is_some()
                    || next.new_conversation_team_id.is_some())
                && !next.selected_available(&tx)?
            {
                next.new_conversation_defaults_require_confirmation = true;
            }
        }
        _ => anyhow::bail!("Unsupported creation preference operation"),
    }
    next.validate()?;
    let changed = saved.as_ref() != Some(&next);
    if changed {
        write(&tx, &next)?;
    }
    tx.commit()?;
    Ok((serde_json::to_value(next)?, changed))
}
