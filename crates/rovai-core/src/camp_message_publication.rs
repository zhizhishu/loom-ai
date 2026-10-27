//! Shared SQL fragments for the durable publication boundary of public Camp messages.
//!
//! `camp_message.sent` and `camp_message.public_a2a_sent` are two publication
//! events for the same public `camp_message` fact. Historical consumers must
//! resolve one deterministic publication sequence per message before applying a
//! global fence; joining the raw event rows directly can duplicate a message.

const PUBLIC_CAMP_MESSAGE_EVENT_TYPES_SQL: &str =
    "'camp_message.sent', 'camp_message.public_a2a_sent'";

/// Returns a predicate for a trusted SQL column expression containing an event type.
pub(crate) fn public_camp_message_event_predicate(event_type_column: &str) -> String {
    format!("{event_type_column} IN ({PUBLIC_CAMP_MESSAGE_EVENT_TYPES_SQL})")
}

/// Returns the shared CTE that resolves the first durable public publication
/// sequence for every Camp message.
pub(crate) fn public_camp_message_publication_cte() -> String {
    format!(
        r#"public_camp_message_publication(message_id, global_sequence) AS (
               SELECT entity_id, MIN(global_sequence)
               FROM event_log
               WHERE entity_type = 'camp_message'
                 AND {}
                 AND entity_id IS NOT NULL
                 AND global_sequence IS NOT NULL
               GROUP BY entity_id
           )"#,
        public_camp_message_event_predicate("event_type")
    )
}

/// An ordered, covering-index publication check for one Camp, never a global event aggregate.
pub(crate) const LAST_VISIBLE_MESSAGE_SQL: &str = r#"SELECT m.created_at, m.id FROM camp_message AS m
        WHERE m.camp_id=camp.id AND m.tombstoned_at IS NULL AND m.recall_state <> 'withdrawn'
          AND EXISTS(SELECT 1 FROM event_log AS e WHERE e.entity_type='camp_message'
              AND e.entity_id=m.id AND e.event_type IN ('camp_message.sent','camp_message.public_a2a_sent')
              AND e.global_sequence IS NOT NULL)
        ORDER BY julianday(m.created_at) DESC, m.id ASC LIMIT 1"#;

pub(crate) const LIVE_DIRECTORY_SQL: &str =
    "SELECT id,title,COALESCE(history_activity_at,created_at)
    FROM camp WHERE id<>?1 AND deletion_operation_id IS NULL
    ORDER BY julianday(COALESCE(history_activity_at,created_at)) DESC,id ASC";

pub(crate) fn directory_needs_initialization(
    connection: &rusqlite::Connection,
) -> rusqlite::Result<bool> {
    connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM camp WHERE history_activity_initialized=0
        AND deletion_operation_id IS NULL)",
        [],
        |r| r.get(0),
    )
}

pub(crate) fn live_directory_sql(connection: &rusqlite::Connection) -> rusqlite::Result<String> {
    if !directory_needs_initialization(connection)? {
        return Ok(LIVE_DIRECTORY_SQL.into());
    }
    // The CASE only seeks within uninitialized Camps. Reads do not initialize or
    // rewrite anything; already initialized rows use their maintained summary.
    let last_time = LAST_VISIBLE_MESSAGE_SQL.replace("m.created_at, m.id", "m.created_at");
    Ok(format!(
        "SELECT id,title,COALESCE(CASE WHEN history_activity_initialized=1 THEN history_activity_at
        ELSE ({last_time}) END,created_at) AS activity_at FROM camp
        WHERE id<>?1 AND deletion_operation_id IS NULL ORDER BY julianday(activity_at) DESC,id ASC"
    ))
}

/// Resume the existing housekeeping loop's bounded metadata initialization.
/// One transaction per small batch; crashes roll it back, and unknown != empty.
pub(crate) fn initialize_directory_activity(
    database: &mut crate::db::Database,
) -> anyhow::Result<bool> {
    let tx = database
        .connection_mut()
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let ids = tx
        .prepare(
            "SELECT id FROM camp WHERE history_activity_initialized=0
        AND deletion_operation_id IS NULL ORDER BY id LIMIT 32",
        )?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let started = std::time::Instant::now();
    let sql = format!("UPDATE camp SET (history_activity_at,history_activity_message_id)=({LAST_VISIBLE_MESSAGE_SQL}),
        history_activity_initialized=1 WHERE id=?1 AND history_activity_initialized=0");
    for id in ids {
        tx.execute(&sql, [id])?;
        if started.elapsed() >= std::time::Duration::from_millis(10) {
            break;
        }
    }
    let pending = directory_needs_initialization(&tx)?;
    tx.commit()?;
    Ok(pending)
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use super::*;

    #[test]
    fn publication_cte_accepts_both_public_events_and_deduplicates_by_first_sequence() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                r#"
                CREATE TABLE event_log(
                    entity_type TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    entity_id TEXT,
                    global_sequence INTEGER
                );
                INSERT INTO event_log VALUES
                    ('camp_message', 'camp_message.public_a2a_sent', 'message-a', 7),
                    ('camp_message', 'camp_message.sent', 'message-a', 3),
                    ('camp_message', 'camp_message.public_a2a_sent', 'message-b', 5),
                    ('camp_message', 'camp_message.private_sent', 'message-c', 2),
                    ('task', 'camp_message.sent', 'message-d', 1),
                    ('camp_message', 'camp_message.sent', NULL, 9);
                "#,
            )
            .unwrap();

        let sql = format!(
            "WITH {} SELECT message_id, global_sequence FROM public_camp_message_publication ORDER BY message_id",
            public_camp_message_publication_cte()
        );
        let mut statement = connection.prepare(&sql).unwrap();
        let publications = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();

        assert_eq!(
            publications,
            vec![("message-a".to_string(), 3), ("message-b".to_string(), 5)]
        );
    }
}
