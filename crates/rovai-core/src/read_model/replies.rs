//! Reply reading follows the persisted single parent, never Run input batches.
//! Only chain identities are traversed; message bodies are hydrated for one page.
use super::*;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplyPageParams {
    #[serde(rename = "threadId")]
    pub camp_id: ThreadId,
    pub message_id: String,
    #[serde(default)]
    pub sequence: i64,
    #[serde(default)]
    pub before: bool,
    #[serde(default = "page_limit")]
    pub limit: i64,
    #[serde(default)]
    pub run_anchor_message_ids: Vec<String>,
}

fn page_limit() -> i64 {
    50
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplyPage {
    pub schema_version: i64,
    #[serde(rename = "threadId")]
    pub camp_id: String,
    pub message_id: String,
    pub root_message_id: Option<String>,
    pub through_global_sequence: i64,
    pub source_available: bool,
    pub reply_count: usize,
    pub has_earlier: bool,
    pub has_later: bool,
    pub messages: Vec<ThreadMessageView>,
    pub run_anchor_message_ids: Vec<String>,
}

// Strictly decreasing/increasing sequence makes corrupt cycles and forward links
// finite. Tombstones remain structural links but their content is never returned.
pub(super) const REPLY_CHAIN_SQL: &str = "
    WITH RECURSIVE parents(id, sequence, parent) AS (
      SELECT id, sequence, reply_to_camp_message_id FROM camp_message
      WHERE camp_id = ?1 AND id = ?2 AND tombstoned_at IS NULL
      UNION ALL
      SELECT m.id, m.sequence, m.reply_to_camp_message_id FROM camp_message m
      JOIN parents p ON m.id = p.parent
      WHERE m.camp_id = ?1 AND m.sequence < p.sequence
    ), root AS (SELECT id FROM parents ORDER BY sequence LIMIT 1),
    chain(id, sequence, visible) AS (
      SELECT m.id, m.sequence, m.tombstoned_at IS NULL FROM camp_message m
      JOIN root ON root.id = m.id
      UNION ALL
      SELECT m.id, m.sequence, m.tombstoned_at IS NULL FROM chain p
      CROSS JOIN camp_message m INDEXED BY camp_message_direct_reply_idx
        ON m.reply_to_camp_message_id = p.id
      WHERE m.camp_id = ?1 AND m.sequence > p.sequence
    ) SELECT id, sequence, visible FROM chain ORDER BY sequence";

impl ReadModelService {
    pub fn reply_page(
        &self,
        database: &mut Database,
        params: &ReplyPageParams,
    ) -> Result<ReplyPage> {
        anyhow::ensure!(params.sequence >= 0, "Reply cursor must not be negative");
        anyhow::ensure!(
            params.run_anchor_message_ids.len() <= 96,
            "Too many Run anchors"
        );
        let tx = database.connection_mut().transaction()?;
        let camp_id = params.camp_id.as_str();
        load_camp(&tx, camp_id)?.context("Thread does not exist")?;
        let through_global_sequence = current_global_sequence(&tx)?;
        let chain = tx
            .prepare(REPLY_CHAIN_SQL)?
            .query_map(params![camp_id, params.message_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, bool>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let root_message_id = chain.first().map(|row| row.0.clone());
        let source_available = !chain.is_empty();
        let identities: BTreeSet<&str> = chain.iter().map(|row| row.0.as_str()).collect();
        let run_anchor_message_ids = params
            .run_anchor_message_ids
            .iter()
            .filter(|id| identities.contains(id.as_str()))
            .cloned()
            .collect();
        let visible: Vec<_> = chain.iter().filter(|row| row.2).collect();
        let reply_count = visible
            .len()
            .saturating_sub(usize::from(chain.first().is_some_and(|row| row.2)));
        let limit = params.limit.clamp(1, 100) as usize;
        let mut page: Vec<_> = if params.before {
            let end = visible.partition_point(|row| row.1 < params.sequence);
            visible[end.saturating_sub(limit)..end].to_vec()
        } else {
            let start = visible.partition_point(|row| row.1 <= params.sequence);
            visible[start..visible.len().min(start + limit)].to_vec()
        };
        // Removals can empty a page; keep the surviving component navigable.
        if page.is_empty() && !visible.is_empty() {
            page = if params.before {
                visible[..visible.len().min(limit)].to_vec()
            } else {
                visible[visible.len().saturating_sub(limit)..].to_vec()
            };
        }
        let has_earlier = page
            .first()
            .is_some_and(|first| visible.first().is_some_and(|row| row.1 < first.1));
        let has_later = page
            .last()
            .is_some_and(|last| visible.last().is_some_and(|row| row.1 > last.1));
        let ids: Vec<_> = page.iter().map(|row| &row.0).collect();
        let rows = tx.prepare("SELECT id, sequence, NULL, author_type, author_id,
            source_agent_run_id, body, structured_content_json, source_attachments_json,
            address_mode, addressed_agent_ids_json, reply_to_camp_message_id, camp_turn_id,
            CASE WHEN author_type = 'agent' THEN recipient_presentation_json ELSE presentation_json END,
            created_at, recall_state, version FROM camp_message
            WHERE camp_id = ?1 AND id IN (SELECT value FROM json_each(?2))
              AND tombstoned_at IS NULL ORDER BY sequence")?
            .query_map(params![camp_id, serde_json::to_string(&ids)?], camp_message_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut messages = hydrate_message_views(&tx, rows)?;
        for message in &mut messages {
            if message.withdrawn {
                message.body.clear();
                message.content.clear();
                message.attachments.clear();
                message.quotes.clear();
            }
        }
        tx.commit()?;
        Ok(ReplyPage {
            schema_version: 1,
            camp_id: camp_id.to_string(),
            message_id: params.message_id.clone(),
            root_message_id,
            through_global_sequence,
            source_available,
            reply_count,
            has_earlier,
            has_later,
            messages,
            run_anchor_message_ids,
        })
    }
}
