//! User-owned creation templates. Threads receive values, never a live Team binding.
use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashSet;

use crate::{
    command::{
        ActorRef, CommandEnvelope, CommandExecution, CommandHandlerResult, DomainCommand,
        DomainCommandGateway, sealed,
    },
    db::Database,
};

pub const MAX_GUIDANCE_CHARS: usize = 10_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Roster {
    pub member_agent_ids: Vec<String>,
    pub default_lead_agent_id: String,
}

impl Roster {
    pub fn validate(&self) -> Result<()> {
        anyhow::ensure!(
            !self.member_agent_ids.is_empty() && self.member_agent_ids.len() <= 100,
            "A Team needs between 1 and 100 members"
        );
        anyhow::ensure!(
            self.member_agent_ids
                .iter()
                .all(|id| !id.is_empty() && id.chars().count() <= 200)
                && self.member_agent_ids.iter().collect::<HashSet<_>>().len()
                    == self.member_agent_ids.len()
                && self.member_agent_ids.contains(&self.default_lead_agent_id),
            "Invalid Team members or Lead"
        );
        Ok(())
    }

    pub fn available(&self, connection: &Connection) -> Result<bool> {
        for id in &self.member_agent_ids {
            if !member_present(connection, id)? {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

fn member_present(connection: &Connection, id: &str) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_profile WHERE id=?1 AND profile_status='present')",
        [id],
        |row| row.get(0),
    )?)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Team {
    pub id: String,
    pub name: String,
    #[serde(flatten)]
    pub roster: Roster,
    pub guidance: String,
    pub version: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TeamSelection {
    pub team_id: String,
    pub expected_version: i64,
}

pub(crate) fn get_on_connection(connection: &Connection, id: &str) -> Result<Option<Team>> {
    let row = connection
        .query_row(
            "SELECT id,name,roster_json,guidance,version FROM team WHERE id=?1",
            [id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            },
        )
        .optional()?;
    row.map(|(id, name, roster, guidance, version)| {
        Ok(Team {
            id,
            name,
            roster: serde_json::from_str(&roster)?,
            guidance,
            version,
        })
    })
    .transpose()
}

pub fn list(database: &Database) -> Result<Vec<Team>> {
    let connection = database.connection();
    let ids = connection
        .prepare("SELECT id FROM team ORDER BY created_at,id")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    ids.iter()
        .map(|id| get_on_connection(connection, id)?.context("Team disappeared while reading"))
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveTeamCommand {
    pub team_id: Option<String>,
    pub expected_version: Option<i64>,
    pub name: String,
    pub member_agent_ids: Vec<String>,
    pub default_lead_agent_id: String,
    pub guidance: String,
}
impl sealed::Sealed for SaveTeamCommand {}
impl DomainCommand for SaveTeamCommand {
    const TYPE: &'static str = "team.save";
}

pub fn save(
    database: &mut Database,
    envelope: &CommandEnvelope<SaveTeamCommand>,
) -> Result<CommandExecution> {
    DomainCommandGateway.execute(database, envelope, |tx| {
        if !matches!(envelope.actor, ActorRef::User { .. }) {
            return Ok(rejected("team.user_required", "Only the User can edit Teams"));
        }
        let input = &envelope.payload;
        let name = input.name.trim();
        let guidance = input.guidance.trim();
        let roster = Roster { member_agent_ids: input.member_agent_ids.clone(), default_lead_agent_id: input.default_lead_agent_id.clone() };
        if name.is_empty() || name.chars().count() > 80 || guidance.chars().count() > MAX_GUIDANCE_CHARS || roster.validate().is_err() {
            return Ok(rejected("team.invalid", "Check the Team name, members, Lead and guidance length"));
        }
        let previous = input.team_id.as_ref().map(|id| get_on_connection(tx, id)).transpose()?.flatten();
        if input.team_id.is_some() != previous.is_some() || previous.as_ref().map(|team| team.version) != input.expected_version {
            return Ok(rejected("team.conflict", "This Team has changed. Reload it before saving"));
        }
        // Existing unavailable members stay visible until the User removes them.
        // New members and a newly selected Lead must be present.
        for id in &roster.member_agent_ids {
            if !member_present(tx, id)? && !previous.as_ref().is_some_and(|team| team.roster.member_agent_ids.contains(id)) {
                return Ok(rejected("team.member_unavailable", "A selected member is unavailable"));
            }
        }
        if !member_present(tx, &roster.default_lead_agent_id)? && !previous.as_ref().is_some_and(|team| team.roster.default_lead_agent_id == roster.default_lead_agent_id) {
            return Ok(rejected("team.member_unavailable", "The selected Lead is unavailable"));
        }
        let id = input.team_id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let version = previous.as_ref().map_or(1, |team| team.version + 1);
        tx.execute("INSERT INTO team(id,name,roster_json,guidance,version,created_at) VALUES(?1,?2,?3,?4,?5,datetime('now'))
            ON CONFLICT(id) DO UPDATE SET name=excluded.name,roster_json=excluded.roster_json,guidance=excluded.guidance,version=excluded.version",
            params![id, name, serde_json::to_string(&roster)?, guidance, version])?;
        Ok(CommandHandlerResult::applied("team.saved", json!({"team": get_on_connection(tx, &id)?}), None))
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteTeamCommand {
    pub team_id: String,
    pub expected_version: i64,
}
impl sealed::Sealed for DeleteTeamCommand {}
impl DomainCommand for DeleteTeamCommand {
    const TYPE: &'static str = "team.delete";
}

pub fn delete(
    database: &mut Database,
    envelope: &CommandEnvelope<DeleteTeamCommand>,
) -> Result<CommandExecution> {
    DomainCommandGateway.execute(database, envelope, |tx| {
        if !matches!(envelope.actor, ActorRef::User { .. }) {
            return Ok(rejected(
                "team.user_required",
                "Only the User can edit Teams",
            ));
        }
        let input = &envelope.payload;
        if tx.execute(
            "DELETE FROM team WHERE id=?1 AND version=?2",
            params![input.team_id, input.expected_version],
        )? == 0
        {
            return Ok(rejected(
                "team.conflict",
                "This Team has changed. Reload it before deleting",
            ));
        }
        // Preserve the independent Custom roster. Deletion never silently enables it.
        crate::creation_preferences::clear_deleted_team(tx, &input.team_id)?;
        Ok(CommandHandlerResult::applied(
            "team.deleted",
            json!({"teamId": input.team_id}),
            None,
        ))
    })
}

fn rejected(code: &str, message: &str) -> CommandHandlerResult {
    CommandHandlerResult::rejected(code, json!({"message": message}))
}

/// Immutable startup text, shared by every member and every later Run of a Thread.
pub(crate) fn thread_guidance(connection: &Connection, camp_id: &str) -> Result<Option<String>> {
    Ok(connection
        .query_row(
            "SELECT guidance FROM thread_team_bootstrap WHERE camp_id=?1",
            [camp_id],
            |row| row.get(0),
        )
        .optional()?)
}

#[cfg(all(test, feature = "extended-tests"))]
#[path = "teams_tests.rs"]
mod tests;
