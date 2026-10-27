CREATE TABLE mission_number_sequence (
    number INTEGER PRIMARY KEY AUTOINCREMENT
);
CREATE TABLE mission (
    id TEXT PRIMARY KEY NOT NULL,
    number INTEGER NOT NULL UNIQUE CHECK(number >= 1),
    camp_id TEXT NOT NULL UNIQUE REFERENCES camp(id) ON DELETE CASCADE,
    title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
    description TEXT NOT NULL CHECK(length(description) <= 12000),
    status TEXT NOT NULL CHECK(status IN ('needs_you','not_started','in_progress','completed')),
    source_message_id TEXT,
    tags_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tags_json) AND json_type(tags_json)='array'),
    source_attachments_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(source_attachments_json) AND json_type(source_attachments_json)='array'),
    details_version INTEGER NOT NULL DEFAULT 1 CHECK(details_version >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX mission_updated_idx ON mission(updated_at DESC, id DESC);
CREATE TABLE mission_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mission_id TEXT NOT NULL REFERENCES mission(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    actor_type TEXT NOT NULL CHECK(actor_type IN ('user','agent','system')),
    actor_id TEXT NOT NULL,
    changes_json TEXT NOT NULL CHECK(json_valid(changes_json)),
    created_at TEXT NOT NULL
);
CREATE INDEX mission_activity_lookup ON mission_activity(mission_id,id DESC);
CREATE TABLE mission_start (
    message_id TEXT PRIMARY KEY NOT NULL REFERENCES camp_message(id) ON DELETE CASCADE,
    mission_id TEXT NOT NULL REFERENCES mission(id) ON DELETE CASCADE,
    camp_turn_id TEXT NOT NULL UNIQUE REFERENCES camp_turn(id) ON DELETE CASCADE,
    command_id TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE mission_pr (
    id TEXT PRIMARY KEY NOT NULL,
    mission_id TEXT NOT NULL REFERENCES mission(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(mission_id,url)
);
CREATE TABLE mission_execution_host (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    id TEXT NOT NULL UNIQUE
);
INSERT INTO mission_execution_host VALUES(1,lower(hex(randomblob(16))));
-- Independent cleanup records survive Mission/Camp deletion.
CREATE TABLE mission_workspace (
    id TEXT PRIMARY KEY NOT NULL,
    mission_id TEXT NOT NULL,
    camp_id TEXT NOT NULL,
    execution_host_id TEXT NOT NULL,
    source_directory TEXT NOT NULL,
    repository_root TEXT NOT NULL,
    git_common_dir TEXT NOT NULL,
    worktree_path TEXT NOT NULL,
    working_directory TEXT NOT NULL,
    base_branch TEXT,
    branch TEXT NOT NULL,
    base_sha TEXT NOT NULL,
    preparation_token TEXT NOT NULL,
    preparation_kind TEXT NOT NULL DEFAULT 'create' CHECK(preparation_kind IN ('create','restore')),
    generation INTEGER NOT NULL DEFAULT 1 CHECK(generation >= 1),
    state TEXT NOT NULL CHECK(state IN ('preparing','ready','cleanup_pending','cleanup_failed')),
    cleanup_command_id TEXT,
    cleanup_expected_branch_oid TEXT,
    cleanup_worktree_removed INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_worktree_removed IN (0,1)),
    cleanup_branch_removed INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_branch_removed IN (0,1)),
    diagnostic TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(mission_id,execution_host_id,git_common_dir),
    UNIQUE(worktree_path),
    UNIQUE(execution_host_id,git_common_dir,branch)
);
CREATE INDEX mission_workspace_cleanup ON mission_workspace(state,updated_at);
ALTER TABLE agent_run ADD COLUMN workspace_preparing_at TEXT;
ALTER TABLE conversation ADD COLUMN native_workspace_fact_digest TEXT;
ALTER TABLE conversation ADD COLUMN mission_details_delivered_version INTEGER CHECK(mission_details_delivered_version IS NULL OR mission_details_delivered_version >= 1);
ALTER TABLE context_manifest ADD COLUMN workspace_fact_json TEXT CHECK(workspace_fact_json IS NULL OR json_valid(workspace_fact_json));
ALTER TABLE context_manifest ADD COLUMN workspace_fact_digest TEXT;
ALTER TABLE context_manifest ADD COLUMN workspace_fact_included INTEGER NOT NULL DEFAULT 0 CHECK(workspace_fact_included IN (0,1));
ALTER TABLE context_manifest ADD COLUMN mission_details_version INTEGER CHECK(mission_details_version IS NULL OR mission_details_version >= 1);
CREATE TRIGGER mission_workspace_binding_reset AFTER UPDATE OF native_binding_id,native_binding_generation ON conversation
WHEN OLD.native_binding_id IS NOT NEW.native_binding_id OR OLD.native_binding_generation IS NOT NEW.native_binding_generation
BEGIN UPDATE conversation SET native_workspace_fact_digest=NULL WHERE id=NEW.id; END;
