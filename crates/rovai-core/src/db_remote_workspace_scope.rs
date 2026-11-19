//! Migration 231 companion: scope `mission_workspace` worktree uniqueness per host.
//!
//! The historical table enforces `UNIQUE(worktree_path)` globally (mission_schema.sql).
//! Two execution hosts may legitimately prepare the same lexical root string, so the
//! constraint becomes `UNIQUE(execution_host_id, worktree_path)`. Every other
//! constraint, default, CHECK and the cleanup index stay exactly as they are.
//!
//! The rebuild reads the *stored* CREATE statement from `sqlite_master` instead of
//! re-declaring the table: old databases reached this schema through ALTER TABLE, so
//! the physical column order is not guaranteed. The statement is edited only in the
//! two narrow places this migration owns, and anything unexpected is an error, never
//! a silent drop.
//!
//! Caller contract: `migrate` runs inside migration 231's existing IMMEDIATE
//! transaction. It never begins or commits one itself, and it does not need
//! `PRAGMA foreign_keys=OFF` because the table carries no foreign keys and no other
//! table may reference it.

use anyhow::{Context, Result, bail, ensure};
use rusqlite::{Connection, OptionalExtension};

const TABLE: &str = "mission_workspace";
const REBUILD_TABLE: &str = "mission_workspace_rws231";
const CLEANUP_INDEX: &str = "mission_workspace_cleanup";
const CLEANUP_INDEX_SQL: &str =
    "CREATE INDEX mission_workspace_cleanup ON mission_workspace(state,updated_at)";
const CLEANUP_INDEX_COLUMNS: [&str; 2] = ["state", "updated_at"];

struct DeclaredColumn {
    name: &'static str,
    ty: &'static str,
    not_null: bool,
    default_value: Option<&'static str>,
    primary_key: bool,
}

/// Exactly the columns `mission_schema.sql` declares, in declaration order. The
/// migration compares them by name, so a legacy ALTER-induced physical order passes.
const COLUMNS: [DeclaredColumn; 23] = [
    DeclaredColumn { name: "id", ty: "TEXT", not_null: true, default_value: None, primary_key: true },
    DeclaredColumn { name: "mission_id", ty: "TEXT", not_null: true, default_value: None, primary_key: false },
    DeclaredColumn { name: "camp_id", ty: "TEXT", not_null: true, default_value: None, primary_key: false },
    DeclaredColumn { name: "execution_host_id", ty: "TEXT", not_null: true, default_value: None, primary_key: false },
    DeclaredColumn { name: "source_directory", ty: "TEXT", not_null: true, default_value: None, primary_key: false },
    DeclaredColumn { name: "repository_root", ty: "TEXT", not_null: true, default_value: None, primary_key: false },
    DeclaredColumn { name: "git_common_dir", ty: "TEXT", not_null: true, default_value: None, primary_key: false },
    DeclaredColumn { name: "worktree_path", ty: "TEXT", not_null: true, default_value: None, primary_key: false },
    DeclaredColumn { name: "working_directory", ty: "TEXT", not_null: true, default_value: None, primary_key: false },
    DeclaredColumn { name: "base_branch", ty: "TEXT", not_null: false, default_value: None, primary_key: false },
    DeclaredColumn { name: "branch", ty: "TEXT", not_null: true, default_value: None, primary_key: false },
    DeclaredColumn { name: "base_sha", ty: "TEXT", not_null: true, default_value: None, primary_key: false },
    DeclaredColumn { name: "preparation_token", ty: "TEXT", not_null: true, default_value: None, primary_key: false },
    DeclaredColumn { name: "preparation_kind", ty: "TEXT", not_null: true, default_value: Some("'create'"), primary_key: false },
    DeclaredColumn { name: "generation", ty: "INTEGER", not_null: true, default_value: Some("1"), primary_key: false },
    DeclaredColumn { name: "state", ty: "TEXT", not_null: true, default_value: None, primary_key: false },
    DeclaredColumn { name: "cleanup_command_id", ty: "TEXT", not_null: false, default_value: None, primary_key: false },
    DeclaredColumn { name: "cleanup_expected_branch_oid", ty: "TEXT", not_null: false, default_value: None, primary_key: false },
    DeclaredColumn { name: "cleanup_worktree_removed", ty: "INTEGER", not_null: true, default_value: Some("0"), primary_key: false },
    DeclaredColumn { name: "cleanup_branch_removed", ty: "INTEGER", not_null: true, default_value: Some("0"), primary_key: false },
    DeclaredColumn { name: "diagnostic", ty: "TEXT", not_null: false, default_value: None, primary_key: false },
    DeclaredColumn { name: "created_at", ty: "TEXT", not_null: true, default_value: None, primary_key: false },
    DeclaredColumn { name: "updated_at", ty: "TEXT", not_null: true, default_value: None, primary_key: false },
];

const UNIQUE_BEFORE: [&[&str]; 3] = [
    &["mission_id", "execution_host_id", "git_common_dir"],
    &["worktree_path"],
    &["execution_host_id", "git_common_dir", "branch"],
];
const UNIQUE_AFTER: [&[&str]; 3] = [
    &["mission_id", "execution_host_id", "git_common_dir"],
    &["execution_host_id", "worktree_path"],
    &["execution_host_id", "git_common_dir", "branch"],
];

/// Rebuild `mission_workspace` with host-scoped worktree uniqueness.
pub(super) fn migrate(connection: &Connection) -> Result<()> {
    ensure!(
        !connection.is_autocommit(),
        "remote_workspace_scope_transaction_required"
    );
    let Some(sql) = table_sql(connection, TABLE)? else {
        bail!("remote_workspace_scope_table_missing");
    };
    ensure!(
        trigger_count(connection, TABLE)? == 0,
        "remote_workspace_scope_trigger_unexpected"
    );
    let indexes = explicit_indexes(connection, TABLE)?;
    ensure!(
        indexes
            == vec![(
                CLEANUP_INDEX.to_string(),
                CLEANUP_INDEX_COLUMNS
                    .iter()
                    .map(|column| column.to_string())
                    .collect::<Vec<_>>()
            )],
        "remote_workspace_scope_index_unexpected"
    );
    ensure!(
        self_foreign_keys(connection, TABLE)? == 0,
        "remote_workspace_scope_foreign_keys_unexpected"
    );
    ensure!(
        external_references(connection, TABLE)?.is_empty(),
        "remote_workspace_scope_external_reference"
    );
    ensure!(
        columns_match(connection, TABLE)?,
        "remote_workspace_scope_columns_unexpected"
    );

    let current = unique_column_sets(connection, TABLE)?;
    ensure!(
        declaration_matches(&sql, current == expected_sets(&UNIQUE_AFTER)),
        "remote_workspace_scope_declaration_unexpected"
    );
    if current == expected_sets(&UNIQUE_AFTER) {
        // Already rebuilt: the rest of the shape was verified above.
        return Ok(());
    }
    ensure!(
        current == expected_sets(&UNIQUE_BEFORE),
        "remote_workspace_scope_unique_unexpected"
    );
    ensure!(
        !table_exists(connection, REBUILD_TABLE)?,
        "remote_workspace_scope_rebuild_table_exists"
    );

    // Only the table identifier and the bare worktree UNIQUE are rewritten; every
    // other byte of the stored declaration (order, CHECKs, defaults) is preserved.
    let rebuilt = narrow_host_scope(&rename_created_table(&sql)?)?;
    connection
        .execute_batch(&rebuilt)
        .context("remote_workspace_scope_create_rebuild")?;
    ensure!(
        columns_match(connection, REBUILD_TABLE)?,
        "remote_workspace_scope_rebuild_columns"
    );
    ensure!(
        unique_column_sets(connection, REBUILD_TABLE)? == expected_sets(&UNIQUE_AFTER),
        "remote_workspace_scope_rebuild_unique"
    );

    let column_list = COLUMNS
        .iter()
        .map(|column| column.name)
        .collect::<Vec<_>>()
        .join(",");
    connection.execute_batch(&format!(
        "INSERT INTO {REBUILD_TABLE} ({column_list}) SELECT {column_list} FROM {TABLE};"
    ))?;
    let before: i64 = connection
        .query_row(&format!("SELECT COUNT(*) FROM {TABLE}"), [], |row| row.get(0))?;
    let after: i64 = connection
        .query_row(&format!("SELECT COUNT(*) FROM {REBUILD_TABLE}"), [], |row| row.get(0))?;
    ensure!(before == after, "remote_workspace_scope_row_count");
    for statement in [
        format!("SELECT {column_list} FROM {TABLE} EXCEPT SELECT {column_list} FROM {REBUILD_TABLE}"),
        format!("SELECT {column_list} FROM {REBUILD_TABLE} EXCEPT SELECT {column_list} FROM {TABLE}"),
    ] {
        let differing: i64 = connection.query_row(
            &format!("SELECT COUNT(*) FROM ({statement})"),
            [],
            |row| row.get(0),
        )?;
        ensure!(differing == 0, "remote_workspace_scope_row_differs");
    }

    connection
        .execute_batch(&format!(
            "DROP TABLE {TABLE};
             ALTER TABLE {REBUILD_TABLE} RENAME TO {TABLE};
             {CLEANUP_INDEX_SQL};"
        ))
        .context("remote_workspace_scope_replace_table")?;
    ensure!(
        schema_matches(connection)?,
        "remote_workspace_scope_not_admitted"
    );
    Ok(())
}

/// Admission check for the current contract (projection schema 181).
pub(super) fn schema_matches(connection: &Connection) -> rusqlite::Result<bool> {
    if !table_exists(connection, TABLE)? || trigger_count(connection, TABLE)? != 0 {
        return Ok(false);
    }
    if self_foreign_keys(connection, TABLE)? != 0
        || !external_references(connection, TABLE)?.is_empty()
    {
        return Ok(false);
    }
    if !columns_match(connection, TABLE)?
        || !table_sql(connection, TABLE)?.as_deref().is_some_and(|sql| declaration_matches(sql, true))
    {
        return Ok(false);
    }
    // The bare path index must be gone and the host-scoped one must exist.
    if unique_column_sets(connection, TABLE)? != expected_sets(&UNIQUE_AFTER) {
        return Ok(false);
    }
    let indexes = explicit_indexes(connection, TABLE)?;
    Ok(indexes
        == vec![(
            CLEANUP_INDEX.to_string(),
            CLEANUP_INDEX_COLUMNS
                .iter()
                .map(|column| column.to_string())
                .collect::<Vec<_>>(),
        )])
}

// Compare complete declarations, including CHECK bodies, collations and defaults.
// Column order may differ after historical ALTER TABLE; quoted string values may not.
fn normalized_declarations(sql: &str) -> Option<Vec<String>> {
    let open=sql.find('(')?;
    let close=sql.rfind(')')?;
    if close <= open || !sql[close+1..].trim().trim_end_matches(';').trim().is_empty() {
        return None;
    }
    let mut clauses=Vec::new();
    let mut clause=String::new();
    let mut depth=0usize;
    let mut quote:Option<(char,bool)>=None;
    for c in sql[open+1..close].chars() {
        if let Some((end,literal))=quote {
            if literal { clause.push(c); }
            else if c!=end { clause.push(c.to_ascii_lowercase()); }
            if c==end { quote=None; }
            continue;
        }
        if c=='\'' {
            quote=Some(('\'',true)); clause.push(c);
        } else if c=='"' || c=='[' || c as u32==96 {
            quote=Some((if c=='[' {']'} else {c},false));
        } else {
            match c {
                '(' => { depth=depth.checked_add(1)?; clause.push(c); }
                ')' => { depth=depth.checked_sub(1)?; clause.push(c); }
                ',' if depth==0 => {
                    if clause.is_empty() {return None;}
                    clauses.push(std::mem::take(&mut clause));
                }
                c if c.is_ascii_whitespace() => {}
                _ => clause.push(c.to_ascii_lowercase()),
            }
        }
    }
    if quote.is_some() || depth!=0 || clause.is_empty() {return None;}
    clauses.push(clause);
    clauses.sort();
    Some(clauses)
}

fn declaration_matches(sql:&str, host_scoped:bool)->bool {
    let historical=include_str!("mission_schema.sql");
    let Some(start)=historical.find("CREATE TABLE mission_workspace (") else {return false;};
    let Some(end)=historical[start..].find(");") else {return false;};
    let expected=&historical[start..start+end+2];
    let expected=if host_scoped {
        expected.replace("UNIQUE(worktree_path)","UNIQUE(execution_host_id,worktree_path)")
    } else {expected.to_string()};
    normalized_declarations(sql).is_some_and(|actual|
        normalized_declarations(&expected).is_some_and(|expected|actual==expected))
}

fn expected_sets(groups: &[&[&str]]) -> Vec<Vec<String>> {
    let mut sets = groups
        .iter()
        .map(|group| group.iter().map(|column| column.to_string()).collect::<Vec<_>>())
        .collect::<Vec<_>>();
    sets.sort();
    sets
}

fn table_sql(connection: &Connection, table: &str) -> rusqlite::Result<Option<String>> {
    connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?1",
            [table],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map(Option::flatten)
}

fn table_exists(connection: &Connection, table: &str) -> rusqlite::Result<bool> {
    connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [table],
        |row| row.get(0),
    )
}

fn trigger_count(connection: &Connection, table: &str) -> rusqlite::Result<i64> {
    connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND tbl_name=?1",
        [table],
        |row| row.get(0),
    )
}

fn self_foreign_keys(connection: &Connection, table: &str) -> rusqlite::Result<i64> {
    connection.query_row(
        "SELECT COUNT(*) FROM pragma_foreign_key_list(?1)",
        [table],
        |row| row.get(0),
    )
}

/// Any other table that declares a reference to this one makes the rebuild unsafe.
fn external_references(connection: &Connection, table: &str) -> rusqlite::Result<Vec<String>> {
    let mut statement = connection.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name<>?1 ORDER BY name",
    )?;
    let others = statement
        .query_map([table], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut referencing = Vec::new();
    for other in others {
        let count: i64 = connection.query_row(
            "SELECT COUNT(*) FROM pragma_foreign_key_list(?1) WHERE \"table\"=?2",
            [&other, table],
            |row| row.get(0),
        )?;
        if count != 0 {
            referencing.push(other);
        }
    }
    Ok(referencing)
}

fn declared_columns(
    connection: &Connection,
    table: &str,
) -> rusqlite::Result<Vec<(String, String, bool, Option<String>, i64)>> {
    let mut statement = connection.prepare(
        "SELECT name, type, \"notnull\", dflt_value, pk FROM pragma_table_info(?1) ORDER BY cid",
    )?;
    statement
        .query_map([table], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
        })?
        .collect()
}

fn columns_match(connection: &Connection, table: &str) -> rusqlite::Result<bool> {
    let actual = declared_columns(connection, table)?;
    if actual.len() != COLUMNS.len() {
        return Ok(false);
    }
    for expected in COLUMNS.iter() {
        let Some((_, ty, not_null, default_value, primary_key)) = actual
            .iter()
            .find(|(name, ..)| name == expected.name)
        else {
            return Ok(false);
        };
        if !ty.eq_ignore_ascii_case(expected.ty)
            || *not_null != expected.not_null
            || default_value.as_deref() != expected.default_value
            || (*primary_key != 0) != expected.primary_key
        {
            return Ok(false);
        }
    }
    Ok(true)
}

fn unique_column_sets(connection: &Connection, table: &str) -> rusqlite::Result<Vec<Vec<String>>> {
    let mut statement = connection.prepare(
        "SELECT name FROM pragma_index_list(?1) WHERE \"unique\"=1 AND origin='u' ORDER BY name",
    )?;
    let names = statement
        .query_map([table], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut sets = Vec::with_capacity(names.len());
    for name in names {
        let mut info = connection.prepare("SELECT name FROM pragma_index_info(?1) ORDER BY seqno")?;
        let columns = info
            .query_map([&name], |row| row.get::<_, Option<String>>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        sets.push(columns);
    }
    sets.sort();
    Ok(sets)
}

fn explicit_indexes(
    connection: &Connection,
    table: &str,
) -> rusqlite::Result<Vec<(String, Vec<String>)>> {
    let mut statement = connection.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?1 AND sql IS NOT NULL
         ORDER BY name",
    )?;
    let names = statement
        .query_map([table], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut indexes = Vec::with_capacity(names.len());
    for name in names {
        let invalid: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_index_list(?1)
             WHERE name=?2 AND (\"unique\"<>0 OR partial<>0))
             OR EXISTS(SELECT 1 FROM pragma_index_xinfo(?2)
             WHERE key=1 AND (cid<0 OR \"desc\"<>0 OR coll<>'BINARY'))",
            [table, name.as_str()], |row| row.get(0),
        )?;
        if invalid {
            indexes.push((name, vec!["unsupported-index-shape".into()]));
            continue;
        }
        let mut info = connection.prepare("SELECT name FROM pragma_index_info(?1) ORDER BY seqno")?;
        let columns = info
            .query_map([&name], |row| row.get::<_, Option<String>>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        indexes.push((name, columns));
    }
    Ok(indexes)
}

/// Rewrites only the identifier that follows `CREATE TABLE`.
fn rename_created_table(sql: &str) -> Result<String> {
    let lowered = sql.to_ascii_lowercase();
    let marker = "create table";
    let head = lowered
        .find(marker)
        .context("remote_workspace_scope_create_missing")?;
    ensure!(
        sql[..head].trim().is_empty(),
        "remote_workspace_scope_create_prefix"
    );
    let rest_start = head + marker.len();
    let bytes = sql.as_bytes();
    let quote = |byte: u8| byte == b'"' || byte == b'\'' || byte == b'`' || byte == b'[';
    let mut cursor = rest_start;
    while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
        cursor += 1;
    }
    ensure!(
        cursor < bytes.len(),
        "remote_workspace_scope_create_identifier"
    );
    let (identifier_start, identifier_end) = if quote(bytes[cursor]) {
        let closing = if bytes[cursor] == b'[' { b']' } else { bytes[cursor] };
        let end = sql[cursor + 1..]
            .bytes()
            .position(|byte| byte == closing)
            .map(|offset| cursor + 1 + offset)
            .context("remote_workspace_scope_create_identifier")?;
        (cursor, end + 1)
    } else {
        let end = sql[cursor..]
            .bytes()
            .position(|byte| byte.is_ascii_whitespace() || byte == b'(')
            .map(|offset| cursor + offset)
            .context("remote_workspace_scope_create_identifier")?;
        (cursor, end)
    };
    let identifier = &sql[identifier_start..identifier_end];
    let bare = identifier.trim_matches(|character| matches!(character, '"' | '\'' | '`' | '[' | ']'));
    ensure!(bare == TABLE, "remote_workspace_scope_create_identifier");
    Ok(format!(
        "{}{}{}",
        &sql[..identifier_start],
        REBUILD_TABLE,
        &sql[identifier_end..]
    ))
}

/// Replaces exactly the single-column `UNIQUE(worktree_path)` group with the
/// host-scoped pair, leaving the other two UNIQUE groups untouched.
fn narrow_host_scope(sql: &str) -> Result<String> {
    let lowered = sql.to_ascii_lowercase();
    let bytes = lowered.as_bytes();
    let mut groups = Vec::new();
    let mut from = 0;
    while let Some(found) = lowered[from..].find("unique") {
        let at = from + found;
        let after = at + "unique".len();
        if at != 0 && bytes[at - 1].is_ascii_alphanumeric() {
            from = after;
            continue;
        }
        let mut cursor = after;
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if bytes.get(cursor) != Some(&b'(') {
            from = after;
            continue;
        }
        let mut depth = 0usize;
        let mut close = None;
        for (offset, byte) in lowered[cursor..].bytes().enumerate() {
            match byte {
                b'(' => depth += 1,
                b')' => {
                    depth -= 1;
                    if depth == 0 {
                        close = Some(cursor + offset);
                        break;
                    }
                }
                _ => {}
            }
        }
        let Some(close) = close else {
            bail!("remote_workspace_scope_unique_unbalanced");
        };
        let columns = sql[cursor + 1..close]
            .split(',')
            .map(|column| {
                column
                    .trim()
                    .trim_matches(|character| matches!(character, '"' | '\'' | '`'))
                    .to_ascii_lowercase()
            })
            .collect::<Vec<_>>();
        if columns.len() == 1 && columns[0] == "worktree_path" {
            groups.push((cursor + 1, close));
        }
        from = close + 1;
    }
    ensure!(groups.len() == 1, "remote_workspace_scope_unique_before");
    let (start, end) = groups[0];
    Ok(format!(
        "{}{}{}",
        &sql[..start], "execution_host_id,worktree_path", &sql[end..]
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn old_workspace_schema() -> (String, String) {
        let schema = include_str!("mission_schema.sql");
        (
            statement(schema, "CREATE TABLE mission_workspace"),
            statement(schema, "CREATE INDEX mission_workspace_cleanup"),
        )
    }

    fn statement(schema: &str, prefix: &str) -> String {
        let start = schema.find(prefix).expect("historical statement");
        let rest = &schema[start..];
        let end = rest.find(");").expect("terminated statement") + 2;
        format!("{};", &rest[..end])
    }

    fn fixture() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        let (table, index) = old_workspace_schema();
        connection
            .execute_batch(&format!("{table}\n{index}"))
            .unwrap();
        connection
    }

    struct Row<'a> {
        id: &'a str,
        mission_id: &'a str,
        host: &'a str,
        git_common_dir: &'a str,
        worktree_path: &'a str,
        branch: &'a str,
    }

    fn insert(connection: &Connection, row: Row<'_>) {
        connection
            .execute(
                "INSERT INTO mission_workspace(
                     id, mission_id, camp_id, execution_host_id, source_directory,
                     repository_root, git_common_dir, worktree_path, working_directory,
                     base_branch, branch, base_sha, preparation_token, preparation_kind,
                     generation, state, cleanup_command_id, cleanup_expected_branch_oid,
                     cleanup_worktree_removed, cleanup_branch_removed, diagnostic,
                     created_at, updated_at)
                 VALUES (?1, ?2, 'camp-1', ?3, '/src', '/src', ?4, ?5, ?5,
                     'main', ?6, 'base-sha', ?7, 'create', 2, 'ready', NULL, NULL, 0, 0,
                     'fixture', '2026-11-04T00:00:00Z', '2026-11-04T00:00:00Z')",
                rusqlite::params![row.id, row.mission_id, row.host, row.git_common_dir,
                    row.worktree_path, row.branch, format!("token-{}", row.id)],
            )
            .unwrap();
    }

    fn seed(connection: &Connection) {
        insert(connection, Row { id: "ws-a", mission_id: "mission-1", host: "node-a",
            git_common_dir: "/src/.git", worktree_path: "/srv/work", branch: "rovai/a" });
        insert(connection, Row { id: "ws-b", mission_id: "mission-1", host: "node-b",
            git_common_dir: "/other/.git", worktree_path: "/srv/other", branch: "rovai/b" });
    }

    /// Every stored column value, in declaration order, so the rebuild can be proven
    /// byte-preserving without relying on column positions inside the CREATE text.
    fn snapshot(connection: &Connection) -> Vec<String> {
        let mut statement = connection
            .prepare(
                "SELECT id, mission_id, camp_id, execution_host_id, source_directory,
                        repository_root, git_common_dir, worktree_path, working_directory,
                        base_branch, branch, base_sha, preparation_token, preparation_kind,
                        generation, state, cleanup_command_id, cleanup_expected_branch_oid,
                        cleanup_worktree_removed, cleanup_branch_removed, diagnostic,
                        created_at, updated_at
                   FROM mission_workspace ORDER BY id",
            )
            .unwrap();
        statement
            .query_map([], |row| {
                let text = |index: usize| row.get::<_, String>(index).unwrap_or_default();
                let optional = |index: usize| row.get::<_, Option<String>>(index).unwrap_or_default();
                let integer = |index: usize| row.get::<_, i64>(index).unwrap_or_default();
                Ok(format!(
                    "{id}|{mission_id}|{camp_id}|{host}|{source}|{repository}|{git}|{worktree}\
                     |{working}|{base_branch:?}|{branch}|{base_sha}|{token}|{kind}|{generation}\
                     |{state}|{cleanup_command:?}|{cleanup_oid:?}|{worktree_removed}\
                     |{branch_removed}|{diagnostic:?}|{created_at}|{updated_at}",
                    id = text(0),
                    mission_id = text(1),
                    camp_id = text(2),
                    host = text(3),
                    source = text(4),
                    repository = text(5),
                    git = text(6),
                    worktree = text(7),
                    working = text(8),
                    base_branch = optional(9),
                    branch = text(10),
                    base_sha = text(11),
                    token = text(12),
                    kind = text(13),
                    generation = integer(14),
                    state = text(15),
                    cleanup_command = optional(16),
                    cleanup_oid = optional(17),
                    worktree_removed = integer(18),
                    branch_removed = integer(19),
                    diagnostic = optional(20),
                    created_at = text(21),
                    updated_at = text(22),
                ))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    }

    fn migrate_in_transaction(connection: &Connection) -> Result<()> {
        let guard = connection.unchecked_transaction()?;
        let outcome = migrate(&guard);
        if outcome.is_ok() {
            guard.commit()?;
        }
        outcome
    }

    /// One owner for both the data-preserving rebuild and the refusal cases.
    #[test]
    fn migration_scopes_worktree_uniqueness_to_the_execution_host() {
        let connection = fixture();
        seed(&connection);
        let before = snapshot(&connection);
        assert!(!schema_matches(&connection).unwrap());
        assert!(migrate(&connection).is_err(), "requires the caller transaction");

        migrate_in_transaction(&connection).unwrap();
        assert!(schema_matches(&connection).unwrap());
        assert_eq!(snapshot(&connection), before, "store bytes must survive");
        // The old bare-path constraint is gone; per-host uniqueness is not.
        insert(&connection, Row { id: "ws-same-path-other-host", mission_id: "mission-2",
            host: "node-b", git_common_dir: "/third/.git", worktree_path: "/srv/work",
            branch: "rovai/c" });
        let same_host = connection.execute(
            "INSERT INTO mission_workspace(
                 id, mission_id, camp_id, execution_host_id, source_directory,
                 repository_root, git_common_dir, worktree_path, working_directory,
                 branch, base_sha, preparation_token, state, created_at, updated_at)
             VALUES ('ws-dup', 'mission-3', 'camp-1', 'node-a', '/src', '/src', '/fourth/.git',
                 '/srv/work', '/srv/work', 'rovai/d', 'base-sha', 'token', 'ready', 'now', 'now')",
            [],
        );
        assert!(same_host.unwrap_err().to_string().contains("UNIQUE"));
        // The remaining two unique groups and the CHECK constraints still apply.
        for statement in [
            "INSERT INTO mission_workspace(
                 id, mission_id, camp_id, execution_host_id, source_directory, repository_root,
                 git_common_dir, worktree_path, working_directory, branch, base_sha,
                 preparation_token, state, created_at, updated_at)
             VALUES ('ws-u2', 'mission-1', 'camp-1', 'node-a', '/src', '/src', '/src/.git',
                 '/srv/fresh', '/srv/fresh', 'rovai/e', 'base-sha', 'token', 'ready', 'now', 'now')",
            "INSERT INTO mission_workspace(
                 id, mission_id, camp_id, execution_host_id, source_directory, repository_root,
                 git_common_dir, worktree_path, working_directory, branch, base_sha,
                 preparation_token, state, created_at, updated_at)
             VALUES ('ws-u3', 'mission-4', 'camp-1', 'node-a', '/src', '/src', '/src/.git',
                 '/srv/fresh2', '/srv/fresh2', 'rovai/a', 'base-sha', 'token', 'ready', 'now', 'now')",
            "INSERT INTO mission_workspace(
                 id, mission_id, camp_id, execution_host_id, source_directory, repository_root,
                 git_common_dir, worktree_path, working_directory, branch, base_sha,
                 preparation_token, state, created_at, updated_at)
             VALUES ('ws-check', 'mission-5', 'camp-1', 'node-a', '/src', '/src', '/src/.git',
                 '/srv/fresh3', '/srv/fresh3', 'rovai/f', 'base-sha', 'token', 'broken', 'now', 'now')",
            "INSERT INTO mission_workspace(
                 id, mission_id, camp_id, execution_host_id, source_directory, repository_root,
                 git_common_dir, worktree_path, working_directory, branch, base_sha,
                 preparation_token, generation, state, created_at, updated_at)
             VALUES ('ws-gen', 'mission-6', 'camp-1', 'node-a', '/src', '/src', '/src/.git',
                 '/srv/fresh4', '/srv/fresh4', 'rovai/g', 'base-sha', 'token', 0, 'ready', 'now', 'now')",
        ] {
            let error=connection.execute(statement, []).unwrap_err().to_string();
            let expected=if statement.contains("ws-u2") {
                "mission_workspace.mission_id, mission_workspace.execution_host_id, mission_workspace.git_common_dir"
            } else if statement.contains("ws-u3") {
                "mission_workspace.execution_host_id, mission_workspace.git_common_dir, mission_workspace.branch"
            } else { "CHECK constraint failed" };
            assert!(error.contains(expected), "expected {expected}, got {error}");

        }
        for statement in [
            "UPDATE mission_workspace SET preparation_kind='unknown'",
            "UPDATE mission_workspace SET cleanup_worktree_removed=2",
            "UPDATE mission_workspace SET cleanup_branch_removed=-1",
        ] {
            let error=connection.execute(statement, []).unwrap_err().to_string();
            assert!(error.contains("CHECK constraint failed"), "{error}");
        }
        // Historical ALTER TABLE can place base_branch last without changing its contract.
        let reordered=Connection::open_in_memory().unwrap();
        let (table,index)=old_workspace_schema();
        let table=table.replace("    base_branch TEXT,\n","")
            .replace("    UNIQUE(mission_id,execution_host_id,git_common_dir),",
                "    base_branch TEXT,\n    UNIQUE(mission_id,execution_host_id,git_common_dir),");
        reordered.execute_batch(&format!("{table}\n{index}")).unwrap();
        seed(&reordered);
        migrate_in_transaction(&reordered).unwrap();
        assert!(schema_matches(&reordered).unwrap());
        // Re-running the migration on the new shape is a no-op.
        migrate_in_transaction(&connection).unwrap();
    }

    #[test]
    fn migration_refuses_unexpected_shapes_and_admission_needs_the_new_index() {
        // Unknown column.
        let extra = fixture();
        seed(&extra);
        extra
            .execute_batch("ALTER TABLE mission_workspace ADD COLUMN extra TEXT;")
            .unwrap();
        assert!(migrate_in_transaction(&extra).is_err());
        assert_eq!(snapshot(&extra).len(), 2);

        // Trigger on the table.
        let triggered = fixture();
        seed(&triggered);
        triggered
            .execute_batch(
                "CREATE TRIGGER fixture_guard BEFORE UPDATE ON mission_workspace
                 BEGIN SELECT RAISE(ABORT, 'fixture'); END;",
            )
            .unwrap();
        assert!(migrate_in_transaction(&triggered).is_err());
        assert_eq!(snapshot(&triggered).len(), 2);

        // External foreign key reference.
        let referenced = fixture();
        seed(&referenced);
        referenced
            .execute_batch(
                "CREATE TABLE fixture_child(
                     id TEXT PRIMARY KEY,
                     workspace_id TEXT REFERENCES mission_workspace(id));",
            )
            .unwrap();
        assert!(migrate_in_transaction(&referenced).is_err());
        assert_eq!(snapshot(&referenced).len(), 2);

        // Unknown explicit index.
        let indexed = fixture();
        seed(&indexed);
        indexed
            .execute_batch("CREATE INDEX fixture_extra ON mission_workspace(id);")
            .unwrap();
        assert!(migrate_in_transaction(&indexed).is_err());
        assert_eq!(snapshot(&indexed).len(), 2);

        let no_check=Connection::open_in_memory().unwrap();
        let (table,index)=old_workspace_schema();
        no_check.execute_batch(&format!("{}\n{index}",table.replace("CHECK(generation >= 1)",""))).unwrap();
        seed(&no_check);
        assert!(migrate_in_transaction(&no_check).is_err(),"same columns without CHECK must be rejected");
        assert_eq!(snapshot(&no_check).len(),2);

        // Admission: old shape, missing index, wrong index columns.
        let admitted = fixture();
        seed(&admitted);
        assert!(!schema_matches(&admitted).unwrap());
        migrate_in_transaction(&admitted).unwrap();
        assert!(schema_matches(&admitted).unwrap());
        admitted
            .execute_batch("DROP INDEX mission_workspace_cleanup;")
            .unwrap();
        assert!(!schema_matches(&admitted).unwrap());
        admitted
            .execute_batch("CREATE INDEX mission_workspace_cleanup ON mission_workspace(updated_at,state);")
            .unwrap();
        assert!(!schema_matches(&admitted).unwrap());
        admitted
            .execute_batch("DROP INDEX mission_workspace_cleanup;")
            .unwrap();
        admitted.execute_batch(CLEANUP_INDEX_SQL).unwrap();
        assert!(schema_matches(&admitted).unwrap());
        for bad in [
            "CREATE INDEX mission_workspace_cleanup ON mission_workspace(state,updated_at) WHERE 0",
            "CREATE UNIQUE INDEX mission_workspace_cleanup ON mission_workspace(state,updated_at)",
            "CREATE INDEX mission_workspace_cleanup ON mission_workspace(state DESC,updated_at)",
            "CREATE INDEX mission_workspace_cleanup ON mission_workspace(state COLLATE NOCASE,updated_at)",
        ] {
            // Empty the fixture before a UNIQUE variant so only definition admission is tested.
            admitted.execute_batch("DELETE FROM mission_workspace; DROP INDEX mission_workspace_cleanup;").unwrap();
            admitted.execute_batch(bad).unwrap();
            assert!(!schema_matches(&admitted).unwrap(),"{bad}");
        }
    }
}
