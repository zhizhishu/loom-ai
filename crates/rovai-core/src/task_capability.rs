//! One instance-owned setting. Discovery is a projection; operations check this
//! value inside the same database transaction that commits their effects.
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

pub const DISABLED_CODE: &str = "task.feature_disabled";
pub const DISABLED_MESSAGE: &str = "Tasks are disabled. Continue with messages.";

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaskPreferences {
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCapabilitySnapshot {
    pub enabled: bool,
    pub heads_up_after_sequence: i64,
    pub observed_through_change_sequence: i64,
}

pub fn snapshot(connection: &Connection) -> Result<TaskCapabilitySnapshot> {
    Ok(TaskCapabilitySnapshot {
        enabled: enabled(connection)?,
        heads_up_after_sequence: connection
            .query_row(
                "SELECT heads_up_after_sequence FROM task_preference WHERE singleton=1",
                [],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(0),
        observed_through_change_sequence: connection.query_row(
            "SELECT current_sequence FROM notification_change_clock WHERE singleton=1",
            [],
            |row| row.get(0),
        )?,
    })
}

pub fn enabled(connection: &Connection) -> Result<bool> {
    let value = connection
        .query_row(
            "SELECT enabled FROM task_preference WHERE singleton=1",
            [],
            |row| row.get::<_, rusqlite::types::Value>(0),
        )
        .optional()?;
    match value {
        None | Some(rusqlite::types::Value::Integer(0)) => Ok(false),
        Some(rusqlite::types::Value::Integer(1)) => Ok(true),
        Some(_) => {
            eprintln!("Invalid Task preference; keeping the record and disabling Tasks");
            Ok(false)
        }
    }
}

pub fn require_enabled(connection: &Connection) -> Result<()> {
    anyhow::ensure!(enabled(connection)?, "{DISABLED_CODE}: {DISABLED_MESSAGE}");
    Ok(())
}

/// The caller owns the Core transaction. No Run, queue or Session is changed.
pub fn set(connection: &Connection, next: bool) -> Result<bool> {
    let changed = enabled(connection)? != next;
    connection.execute(
        "INSERT INTO task_preference(singleton,enabled,heads_up_after_sequence)
         SELECT 1,?1,current_sequence FROM notification_change_clock WHERE singleton=1
         ON CONFLICT(singleton) DO UPDATE SET enabled=excluded.enabled,
         heads_up_after_sequence=CASE WHEN task_preference.enabled=0 AND excluded.enabled=1
           THEN excluded.heads_up_after_sequence ELSE task_preference.heads_up_after_sequence END",
        [next],
    )?;
    if changed {
        // Visibility is a notification projection change. Tick the existing clock
        // even without a journal row, so reads before/after a toggle can be ordered.
        // Capture the enable boundary first; reads and same-value saves never move it.
        connection.execute(
            "UPDATE notification_change_clock SET current_sequence=current_sequence+1 WHERE singleton=1",
            [],
        )?;
    }
    Ok(changed)
}

pub fn unavailable_result() -> serde_json::Value {
    serde_json::json!({"error":{"code":DISABLED_CODE,"message":DISABLED_MESSAGE,"recovery":"stop"}})
}

pub fn is_task_operation(operation: &str) -> bool {
    matches!(
        operation,
        "team.create_task" | "team.get_task" | "team.list_tasks" | "team.update_task"
    )
}
