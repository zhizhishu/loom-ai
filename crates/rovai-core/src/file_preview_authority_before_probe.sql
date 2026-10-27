
            SELECT activity.diff_projection_json, rovai_execution_preview(evidence.storage_version, evidence.payload_preview_json, evidence.input_preview_json, evidence.result_preview_json),
                   evidence.phase, activity.outcome
            FROM agent_run_execution_evidence AS evidence
            JOIN agent_run ON agent_run.id = evidence.agent_run_id
            LEFT JOIN camp_turn ON camp_turn.id = agent_run.camp_turn_id
            JOIN camp ON camp.id = COALESCE(agent_run.camp_id, camp_turn.camp_id)
            JOIN execution_activity AS activity
              ON activity.agent_run_id = evidence.agent_run_id
             AND activity.execution_epoch = evidence.execution_epoch
            WHERE evidence.id = ?1
              AND evidence.agent_run_id = ?2
              AND evidence.execution_epoch = ?3
              AND camp.id = ?4
              AND camp.activation_state = 'active'
              AND camp.deletion_operation_id IS NULL
              AND activity.classifier_version IN (?5, ?6, ?7, ?8)
              AND EXISTS (
                  SELECT 1
                  FROM json_each(activity.source_evidence_ids_json)
                  WHERE json_each.value = evidence.id
              )
            ORDER BY CASE activity.classifier_version
                WHEN ?5 THEN 0
                WHEN ?6 THEN 1
                WHEN ?7 THEN 2
                ELSE 3
            END
            LIMIT 1
            