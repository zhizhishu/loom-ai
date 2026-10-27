//! Bounded interruption attention. Dispositions remain the only read authority.
use super::*;

pub const MAX_INTERRUPTION_THREADS: usize = 200;

// This predicate is about exact durable identity, never about a loaded UI page.
const AVAILABLE_SOURCE: &str = "EXISTS (
    SELECT 1 FROM agent_run r LEFT JOIN conversation c ON c.id=r.destination_conversation_id
    WHERE r.id=occurrence.agent_run_id
      AND (r.invocation_kind<>'single_chat' OR (c.kind='single_chat' AND c.ended_at IS NULL AND c.camp_id=occurrence.camp_id))
)";

const CANDIDATES: &str = "FROM notification_occurrence AS occurrence
    INDEXED BY notification_interruption_thread_idx
    JOIN notification_occurrence_disposition d ON d.occurrence_id=occurrence.id
    JOIN notification_episode_disposition e ON e.episode_id=occurrence.episode_id
    WHERE occurrence.interruption_kind IN ('app_shutdown','execution_lost')
      AND occurrence.recipient_user_id=?1 AND occurrence.camp_id=?2
      AND occurrence.admitted_change_sequence<=?3
      AND occurrence.admitted_attention_revision>e.cleared_through_attention_revision";

pub(super) fn projection_query() -> String {
    let candidates = CANDIDATES.replace(
        "occurrence.camp_id=?2",
        "occurrence.camp_id=requested.value",
    );
    format!(
        "SELECT DISTINCT requested.value, EXISTS(SELECT 1 {candidates}
        AND d.acknowledged_at IS NULL AND {AVAILABLE_SOURCE}) FROM json_each(?2) requested"
    )
}
pub(super) fn acknowledgement_query() -> String {
    format!("UPDATE notification_occurrence_disposition
        SET acknowledged_at=?4,updated_at=?4
        WHERE acknowledged_at IS NULL AND occurrence_id IN (
            SELECT occurrence.id {CANDIDATES} AND d.acknowledged_at IS NULL AND {AVAILABLE_SOURCE})")
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NotificationThreadInterruptionsParams {
    pub thread_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationThreadInterruption {
    pub thread_id: String,
    pub has_unread_interruption: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationThreadInterruptions {
    pub through_change_sequence: i64,
    pub threads: Vec<NotificationThreadInterruption>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcknowledgeThreadInterruptionsCommand {
    #[serde(deserialize_with = "crate::camp_id::deserialize_camp_id_string")]
    pub thread_id: String,
    pub observed_through_change_sequence: i64,
}

impl sealed::Sealed for AcknowledgeThreadInterruptionsCommand {}
impl DomainCommand for AcknowledgeThreadInterruptionsCommand {
    const TYPE: &'static str = "notification_episode.acknowledge_thread_interruptions";
}

/// Created only from this Core's admitted authority. A lazy, read-only WAL
/// connection avoids waiting for optional startup maintenance's writer mutex.
/// It owns no recovery, migration, cache, read watermark or background worker.
pub struct NotificationInterruptionReader {
    path: std::path::PathBuf,
    connection: Option<rusqlite::Connection>,
}

impl NotificationInterruptionReader {
    pub fn for_database(database: &Database) -> Self {
        Self {
            path: database.path().to_owned(),
            connection: None,
        }
    }

    pub fn read(
        &mut self,
        recipient: &str,
        ids: &[String],
    ) -> Result<NotificationThreadInterruptions> {
        if self.connection.is_none() {
            let connection = rusqlite::Connection::open_with_flags(
                &self.path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )?;
            connection.execute_batch("PRAGMA query_only=ON")?;
            self.connection = Some(connection);
        }
        read_projection(
            self.connection.as_mut().expect("opened read connection"),
            recipient,
            ids,
        )
    }
}

fn read_projection(
    connection: &mut rusqlite::Connection,
    recipient: &str,
    ids: &[String],
) -> Result<NotificationThreadInterruptions> {
    anyhow::ensure!(
        recipient == CURRENT_USER_ID,
        "interruption projection requires the current User"
    );
    anyhow::ensure!(
        ids.len() <= MAX_INTERRUPTION_THREADS && ids.iter().all(|id| !id.trim().is_empty()),
        "interruption projection requires at most 200 non-empty Thread IDs"
    );
    let tx = connection.transaction()?;
    let boundary = change_clock(&tx)?.0;
    // One bounded query. Each EXISTS begins at the requested Thread's partial
    // index; neither Inbox hydration nor historical Thread enumeration occurs.
    let query = projection_query();
    let threads = tx
        .prepare(&query)?
        .query_map(
            params![recipient, serde_json::to_string(ids)?, boundary],
            |row| {
                Ok(NotificationThreadInterruption {
                    thread_id: row.get(0)?,
                    has_unread_interruption: row.get(1)?,
                })
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    tx.commit()?;
    Ok(NotificationThreadInterruptions {
        through_change_sequence: boundary,
        threads,
    })
}

impl NotificationEpisodeService {
    pub fn thread_interruptions(
        &self,
        database: &mut Database,
        recipient: &str,
        ids: &[String],
    ) -> Result<NotificationThreadInterruptions> {
        read_projection(database.connection_mut(), recipient, ids)
    }

    pub fn acknowledge_thread_interruptions(
        &self,
        database: &mut Database,
        envelope: &CommandEnvelope<AcknowledgeThreadInterruptionsCommand>,
    ) -> Result<CommandExecution> {
        let recipient = user_id(&envelope.actor)?.to_owned();
        self.gateway.execute(database, envelope, |tx| {
            let input = &envelope.payload;
            if input.thread_id.trim().is_empty()
                || input.observed_through_change_sequence < 0
                || input.observed_through_change_sequence > change_clock(tx)?.0
            {
                return Ok(rejected(
                    "notification_episode.invalid_interruption_boundary",
                    "Thread and observed notification boundary are required",
                ));
            }
            let query = acknowledgement_query();
            let changed = tx.execute(
                &query,
                params![
                    recipient,
                    input.thread_id,
                    input.observed_through_change_sequence,
                    chrono::Utc::now().to_rfc3339()
                ],
            )?;
            Ok(applied_change(
                "notification_episode.thread_interruptions_acknowledged",
                changed,
                json!({"threadId":input.thread_id,
                    "observedThroughChangeSequence":input.observed_through_change_sequence,
                    "resultingChangeSequence":change_clock(tx)?.0}),
            ))
        })
    }
}
