-- Current directory facts only. Existing Camps remain explicitly uninitialized until
-- bounded background maintenance fills these small fields. No historical body is read.
ALTER TABLE camp ADD COLUMN history_activity_at TEXT;
ALTER TABLE camp ADD COLUMN history_activity_message_id TEXT;
ALTER TABLE camp ADD COLUMN history_activity_initialized INTEGER NOT NULL DEFAULT 0 CHECK(history_activity_initialized IN (0,1));
CREATE INDEX camp_history_uninitialized_idx ON camp(id)
    WHERE history_activity_initialized=0 AND deletion_operation_id IS NULL;
CREATE INDEX camp_history_directory_idx ON camp(julianday(COALESCE(history_activity_at,created_at)) DESC,id)
    WHERE deletion_operation_id IS NULL;
CREATE INDEX camp_message_history_activity_idx ON camp_message(camp_id,julianday(created_at) DESC,id,created_at)
    WHERE tombstoned_at IS NULL AND recall_state <> 'withdrawn';
CREATE TRIGGER camp_history_new AFTER INSERT ON camp
BEGIN
    UPDATE camp SET history_activity_initialized=1 WHERE id=NEW.id;
END;

CREATE TRIGGER camp_history_publication AFTER INSERT ON event_log
WHEN NEW.entity_type='camp_message' AND NEW.global_sequence IS NOT NULL
 AND NEW.event_type IN ('camp_message.sent','camp_message.public_a2a_sent')
BEGIN
    UPDATE camp SET history_activity_at=m.created_at,history_activity_message_id=m.id
    FROM camp_message AS m
    WHERE m.id=NEW.entity_id AND camp.id=m.camp_id
      AND camp.history_activity_initialized=1 AND camp.deletion_operation_id IS NULL
      AND m.tombstoned_at IS NULL AND m.recall_state <> 'withdrawn'
      AND (camp.history_activity_message_id IS NULL
        OR julianday(m.created_at)>julianday(camp.history_activity_at)
        OR (julianday(m.created_at)=julianday(camp.history_activity_at) AND m.id<camp.history_activity_message_id));
END;

CREATE TRIGGER camp_history_sequence AFTER UPDATE OF global_sequence ON event_log
WHEN NEW.entity_type='camp_message' AND NEW.global_sequence IS NOT NULL
 AND NEW.event_type IN ('camp_message.sent','camp_message.public_a2a_sent')
BEGIN
    UPDATE camp SET history_activity_at=m.created_at,history_activity_message_id=m.id
    FROM camp_message AS m
    WHERE m.id=NEW.entity_id AND camp.id=m.camp_id
      AND camp.history_activity_initialized=1 AND camp.deletion_operation_id IS NULL
      AND m.tombstoned_at IS NULL AND m.recall_state <> 'withdrawn'
      AND (camp.history_activity_message_id IS NULL
        OR julianday(m.created_at)>julianday(camp.history_activity_at)
        OR (julianday(m.created_at)=julianday(camp.history_activity_at) AND m.id<camp.history_activity_message_id));
END;

-- Only the current last message or a newly visible/newer candidate can change the
-- answer. Closing a recall window, changing a body, or withdrawing an older message
-- cannot cause a history scan. The ordered seek stays inside the affected Camp.
CREATE TRIGGER camp_history_visibility AFTER UPDATE OF tombstoned_at,recall_state,created_at ON camp_message
WHEN ((OLD.tombstoned_at IS NULL AND OLD.recall_state <> 'withdrawn')
      <> (NEW.tombstoned_at IS NULL AND NEW.recall_state <> 'withdrawn'))
  OR OLD.created_at IS NOT NEW.created_at
BEGIN
    UPDATE camp SET (history_activity_at,history_activity_message_id)=(SELECT m.created_at, m.id FROM camp_message AS m
        WHERE m.camp_id=camp.id AND m.tombstoned_at IS NULL AND m.recall_state <> 'withdrawn'
          AND EXISTS(SELECT 1 FROM event_log AS e WHERE e.entity_type='camp_message'
              AND e.entity_id=m.id AND e.event_type IN ('camp_message.sent','camp_message.public_a2a_sent')
              AND e.global_sequence IS NOT NULL)
        ORDER BY julianday(m.created_at) DESC, m.id ASC LIMIT 1)
    WHERE id=NEW.camp_id AND history_activity_initialized=1 AND deletion_operation_id IS NULL
      AND (history_activity_message_id=NEW.id
        OR (NEW.tombstoned_at IS NULL AND NEW.recall_state <> 'withdrawn'
          AND (history_activity_message_id IS NULL OR julianday(NEW.created_at)>julianday(history_activity_at)
            OR (julianday(NEW.created_at)=julianday(history_activity_at) AND NEW.id<history_activity_message_id))
          AND EXISTS(SELECT 1 FROM event_log AS e WHERE e.entity_type='camp_message'
            AND e.entity_id=NEW.id AND e.event_type IN ('camp_message.sent','camp_message.public_a2a_sent')
            AND e.global_sequence IS NOT NULL)));
END;
CREATE TRIGGER camp_history_message_delete AFTER DELETE ON camp_message
BEGIN
    UPDATE camp SET (history_activity_at,history_activity_message_id)=(SELECT m.created_at, m.id FROM camp_message AS m
        WHERE m.camp_id=camp.id AND m.tombstoned_at IS NULL AND m.recall_state <> 'withdrawn'
          AND EXISTS(SELECT 1 FROM event_log AS e WHERE e.entity_type='camp_message'
              AND e.entity_id=m.id AND e.event_type IN ('camp_message.sent','camp_message.public_a2a_sent')
              AND e.global_sequence IS NOT NULL)
        ORDER BY julianday(m.created_at) DESC, m.id ASC LIMIT 1)
    WHERE id=OLD.camp_id AND history_activity_initialized=1 AND deletion_operation_id IS NULL
      AND history_activity_message_id=OLD.id;
END;
CREATE TRIGGER camp_history_publication_delete AFTER DELETE ON event_log
WHEN OLD.entity_type='camp_message'
 AND OLD.event_type IN ('camp_message.sent','camp_message.public_a2a_sent') AND OLD.global_sequence IS NOT NULL
BEGIN
    UPDATE camp SET (history_activity_at,history_activity_message_id)=(SELECT m.created_at, m.id FROM camp_message AS m
        WHERE m.camp_id=camp.id AND m.tombstoned_at IS NULL AND m.recall_state <> 'withdrawn'
          AND EXISTS(SELECT 1 FROM event_log AS e WHERE e.entity_type='camp_message'
              AND e.entity_id=m.id AND e.event_type IN ('camp_message.sent','camp_message.public_a2a_sent')
              AND e.global_sequence IS NOT NULL)
        ORDER BY julianday(m.created_at) DESC, m.id ASC LIMIT 1)
    WHERE id=(SELECT camp_id FROM camp_message WHERE id=OLD.entity_id)
      AND history_activity_initialized=1 AND deletion_operation_id IS NULL
      AND history_activity_message_id=OLD.entity_id
      AND NOT EXISTS(SELECT 1 FROM event_log AS e WHERE e.entity_type='camp_message'
        AND e.entity_id=OLD.entity_id AND e.event_type IN ('camp_message.sent','camp_message.public_a2a_sent')
        AND e.global_sequence IS NOT NULL);
END;
