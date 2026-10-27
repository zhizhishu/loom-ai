use super::*;
use crate::{
    collaboration::{CollaborationService, CreateThreadCommand},
    creation_preferences,
};

fn envelope<T>(id: &str, payload: T) -> CommandEnvelope<T> {
    CommandEnvelope {
        command_id: id.into(),
        actor: ActorRef::User {
            user_id: "local_user".into(),
        },
        camp_id: None,
        expected_versions: vec![],
        execution_epoch: None,
        payload,
    }
}

#[test]
fn templates_preserve_custom_defaults_and_freeze_thread_guidance() {
    let mut db = crate::test_support::fresh_schema_database_fast_owned();
    let directory = db.directory().to_path_buf();
    let legacy = json!({"newConversationDefaults":{"memberAgentIds":["agent_2"],"defaultLeadAgentId":"agent_2"},
        "newConversationDefaultsRequireConfirmation":false,"oneClickNewConversationEnabled":true});
    let legacy_bytes = serde_json::to_vec(&legacy).unwrap();
    std::fs::write(
        directory.join("new-conversation-preferences.json"),
        &legacy_bytes,
    )
    .unwrap();
    let (imported, _) = creation_preferences::execute(
        &directory,
        &mut db,
        "preferences.newConversation.get",
        json!({}),
    )
    .unwrap();
    assert_eq!(
        imported["newConversationDefaults"],
        legacy["newConversationDefaults"]
    );
    assert!(imported["newConversationTeamId"].is_null());
    assert!(list(&db).unwrap().is_empty());
    // Desktop's older local initialization cannot overwrite the Core-owned import.
    creation_preferences::execute(&directory, &mut db, "preferences.newConversation.initialize", json!({"newConversationDefaults":null,"newConversationDefaultsRequireConfirmation":false,"oneClickNewConversationEnabled":false})).unwrap();
    let mut draft = SaveTeamCommand {
        team_id: None,
        expected_version: None,
        name: "  Review  ".into(),
        member_agent_ids: vec!["agent_1".into(), "agent_3".into()],
        default_lead_agent_id: "agent_3".into(),
        guidance: "  简洁回答。\n先验证。  ".into(),
    };
    let command = envelope("team-create", draft.clone());
    let first = save(&mut db, &command).unwrap();
    assert_eq!(first.result.code, "team.saved");
    assert_eq!(
        save(&mut db, &command).unwrap().result.payload,
        first.result.payload
    );
    let team = list(&db).unwrap().remove(0);
    assert_eq!(team.name, "Review");
    assert_eq!(team.guidance, "简洁回答。\n先验证。");
    assert_eq!(team.version, 1);

    creation_preferences::execute(
        &directory,
        &mut db,
        "preferences.newConversation.setOneClick",
        json!({"enabled":false}),
    )
    .unwrap();
    creation_preferences::execute(
        &directory,
        &mut db,
        "preferences.newConversation.setTeam",
        json!({"teamId":team.id,"enableOneClick":true}),
    )
    .unwrap();
    let (selected, _) = creation_preferences::execute(
        &directory,
        &mut db,
        "preferences.newConversation.get",
        json!({}),
    )
    .unwrap();
    assert_eq!(
        selected["newConversationDefaults"],
        legacy["newConversationDefaults"]
    );
    assert_eq!(selected["newConversationTeamId"], team.id);
    assert_eq!(selected["oneClickNewConversationEnabled"], true);

    let service = CollaborationService::default();
    let mut create = CreateThreadCommand::for_test(directory.to_string_lossy().into_owned());
    create.team = Some(TeamSelection {
        team_id: team.id.clone(),
        expected_version: 1,
    });
    // A fault after inserting the Thread must roll back the Thread and its receipt.
    let camp_count: i64 = db
        .connection()
        .query_row("SELECT count(*) FROM camp", [], |r| r.get(0))
        .unwrap();
    db.connection().execute_batch("CREATE TEMP TRIGGER fail_team_bootstrap BEFORE INSERT ON thread_team_bootstrap BEGIN SELECT RAISE(ABORT,'team snapshot fault'); END;").unwrap();
    let create_command = envelope("team-thread-create", create.clone());
    assert!(service.create_camp(&mut db, &create_command).is_err());
    assert_eq!(
        db.connection()
            .query_row("SELECT count(*) FROM camp", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        camp_count
    );
    db.connection()
        .execute_batch("DROP TRIGGER fail_team_bootstrap;")
        .unwrap();
    let created = service.create_camp(&mut db, &create_command).unwrap();
    let thread_id = created.result.payload["threadId"].as_str().unwrap();
    assert_eq!(created.result.payload["defaultLeadAgentId"], "agent_3");
    assert_eq!(created.result.payload["memberCount"], 2);
    assert_eq!(
        thread_guidance(db.connection(), thread_id)
            .unwrap()
            .as_deref(),
        Some(team.guidance.as_str())
    );
    assert!(
        db.connection()
            .execute(
                "UPDATE thread_team_bootstrap SET guidance='edited' WHERE camp_id=?1",
                [thread_id]
            )
            .is_err()
    );

    // A delayed invalidation must not undo reconfirmation of a repaired Team
    // with the same ID and unchanged independent Custom defaults.
    db.connection()
        .execute(
            "UPDATE agent_profile SET profile_status='away' WHERE id='agent_1'",
            [],
        )
        .unwrap();
    let stale_invalidation = json!({
        "expectedTeamId": selected["newConversationTeamId"],
        "expectedDefaults": selected["newConversationDefaults"]
    });
    let (invalid, changed) = creation_preferences::execute(
        &directory,
        &mut db,
        "preferences.newConversation.invalidate",
        stale_invalidation.clone(),
    )
    .unwrap();
    assert!(changed);
    assert_eq!(invalid["newConversationDefaultsRequireConfirmation"], true);

    draft.team_id = Some(team.id.clone());
    draft.expected_version = Some(1);
    draft.member_agent_ids = vec!["agent_3".into()];
    draft.guidance = "New guidance".into();
    assert_eq!(
        save(&mut db, &envelope("team-update", draft.clone()))
            .unwrap()
            .result
            .code,
        "team.saved"
    );
    assert_eq!(list(&db).unwrap()[0].version, 2);
    let (confirmed, _) = creation_preferences::execute(
        &directory,
        &mut db,
        "preferences.newConversation.setTeam",
        json!({"teamId":team.id}),
    )
    .unwrap();
    assert_eq!(
        confirmed["newConversationDefaultsRequireConfirmation"],
        false
    );
    let (after_stale, changed) = creation_preferences::execute(
        &directory,
        &mut db,
        "preferences.newConversation.invalidate",
        stale_invalidation,
    )
    .unwrap();
    assert!(!changed, "a repaired Team must ignore the old invalidation");
    assert_eq!(after_stale, confirmed);
    assert_eq!(after_stale["oneClickNewConversationEnabled"], true);
    // This checks the same persisted admission used to enable one-click creation.
    creation_preferences::execute(
        &directory,
        &mut db,
        "preferences.newConversation.setOneClick",
        json!({"enabled":true}),
    )
    .unwrap();
    db.connection()
        .execute(
            "UPDATE agent_profile SET profile_status='present' WHERE id='agent_1'",
            [],
        )
        .unwrap();
    assert_eq!(
        save(&mut db, &envelope("team-stale-save", draft.clone()))
            .unwrap()
            .result
            .code,
        "team.conflict"
    );
    assert_eq!(
        service
            .create_camp(&mut db, &envelope("team-stale-create", create.clone()))
            .unwrap()
            .result
            .code,
        "team.conflict"
    );
    assert_eq!(
        service
            .create_camp(&mut db, &create_command)
            .unwrap()
            .result
            .payload,
        created.result.payload
    );
    assert_eq!(
        thread_guidance(db.connection(), thread_id)
            .unwrap()
            .as_deref(),
        Some(team.guidance.as_str())
    );
    create.team.as_mut().unwrap().expected_version = 2;
    let newer = service
        .create_camp(&mut db, &envelope("team-new-thread", create.clone()))
        .unwrap();
    assert_eq!(
        thread_guidance(
            db.connection(),
            newer.result.payload["threadId"].as_str().unwrap()
        )
        .unwrap()
        .as_deref(),
        Some("New guidance")
    );
    create.team = None;
    let custom = service
        .create_camp(&mut db, &envelope("custom-thread", create))
        .unwrap();
    assert!(
        thread_guidance(
            db.connection(),
            custom.result.payload["threadId"].as_str().unwrap()
        )
        .unwrap()
        .is_none()
    );

    draft.expected_version = Some(2);
    for character in ["花", "🌸"] {
        draft.guidance = character.repeat(10001);
        assert_eq!(
            save(
                &mut db,
                &envelope(&format!("team-too-long-{character}"), draft.clone())
            )
            .unwrap()
            .result
            .code,
            "team.invalid"
        );
    }
    draft.guidance = "花🌸".repeat(5000);
    assert_eq!(
        save(&mut db, &envelope("team-max-guidance", draft.clone()))
            .unwrap()
            .result
            .code,
        "team.saved"
    );
    assert_eq!(list(&db).unwrap()[0].guidance, draft.guidance);
    let mut long_create = CreateThreadCommand::for_test(directory.to_string_lossy().into_owned());
    long_create.team = Some(TeamSelection {
        team_id: team.id.clone(),
        expected_version: 3,
    });
    let long_thread = service
        .create_camp(&mut db, &envelope("long-team-thread", long_create))
        .unwrap();
    assert_eq!(long_thread.result.code, created.result.code);
    assert_eq!(
        thread_guidance(
            db.connection(),
            long_thread.result.payload["threadId"].as_str().unwrap()
        )
        .unwrap()
        .as_deref(),
        Some(draft.guidance.as_str())
    );
    let delete_command = envelope(
        "team-delete",
        DeleteTeamCommand {
            team_id: team.id.clone(),
            expected_version: 3,
        },
    );
    assert_eq!(
        delete(&mut db, &delete_command).unwrap().result.code,
        "team.deleted"
    );
    assert_eq!(
        delete(&mut db, &delete_command).unwrap().result.code,
        "team.deleted"
    );
    assert!(list(&db).unwrap().is_empty());
    assert_eq!(
        thread_guidance(db.connection(), thread_id)
            .unwrap()
            .as_deref(),
        Some(team.guidance.as_str())
    );
    let (fallback, _) = creation_preferences::execute(
        &directory,
        &mut db,
        "preferences.newConversation.get",
        json!({}),
    )
    .unwrap();
    assert_eq!(
        fallback["newConversationDefaults"],
        legacy["newConversationDefaults"]
    );
    assert!(fallback["newConversationTeamId"].is_null());
    assert_eq!(fallback["oneClickNewConversationEnabled"], false);
    assert_eq!(
        std::fs::read(directory.join("new-conversation-preferences.json")).unwrap(),
        legacy_bytes
    );
}
