use super::*;
use std::{fs, os::unix::fs::PermissionsExt};

// LOOM 自有决定（Claude 禁用，2026-11-18）：Claude Code 只识别，不启动。
//
// 这个 owner 原本跨过真实的 managed-process/NDJSON 边界（list_models、
// initialize 回退、超时、超长帧等 13 个夹具场景）。产品禁用后，策略闸门在
// spawn 之前就拒绝，那些场景已经不可达；此用例改为固化策略事实：
// 未 opt-in 时模型目录查询与健康探测都被拒绝，且夹具从未被执行。
#[tokio::test]
async fn claude_catalog_probe_is_refused_by_policy_before_any_process() {
    assert!(
        !rovai_core::runtime_platform_admission::claude_runtime_enabled_by_policy_opt_in(),
        "这个用例断言默认策略（Claude 已禁用）；LOOM_CLAUDE_RUNTIME_ENABLED=1 是\
         经渠道网关（如 oct）的手工测试开关，不要在测试进程里设置"
    );
    let root = env::temp_dir().join(format!("rovai-claude-catalog-{}", uuid::Uuid::new_v4()));
    let _cleanup = ProbeRootCleanup(root.clone());
    fs::create_dir_all(&root).unwrap();
    let executable = root.join("claude-fixture");
    fs::write(
        &executable,
        "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$(/usr/bin/dirname \"$0\")/launches\"\n",
    )
    .unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();

    // 两条入口都必须被 AvailabilityCheck 闸门拒绝，且在 spawn 之前。
    let catalog = refresh_model_catalog(&executable, AdapterKind::ClaudeCodeCli).await;
    let catalog_error = catalog.expect_err("a disabled Runtime must not report a model catalog");
    assert!(
        format!("{catalog_error:#}").contains("runtime_launch_disallowed_for_availability_check"),
        "{catalog_error:#}"
    );
    let direct = claude_code_model_catalog(&executable, Duration::from_secs(10)).await;
    let direct_error = direct.expect_err("a disabled Runtime must not query list_models");
    assert!(
        format!("{direct_error:#}").contains("runtime_launch_disallowed_for_availability_check"),
        "{direct_error:#}"
    );

    // 健康探测同样不得执行 --version/--help/auth status。
    let probe = claude_code_capability_probe_at(&executable, None, None, &[]).await;
    assert_eq!(probe.result.status, AgentRuntimeProbeStatus::ProbeFailed);
    assert!(
        probe
            .result
            .detail
            .as_deref()
            .is_some_and(|detail| detail.contains("runtime_launch_disallowed_for_health_probe")),
        "{:?}",
        probe.result.detail
    );
    assert_eq!(probe.result.reported_version, None);
    assert!(probe.models.is_empty());
    let failure = probe.result.failure.expect("policy refusal carries a failure");
    assert_eq!(failure.code, "runtime_disabled_by_policy");
    assert_eq!(failure.phase, RuntimeFailurePhase::Spawn);
    assert!(!failure.retryable);

    assert!(
        !root.join("launches").exists(),
        "policy refusal must not execute the Claude executable"
    );
}

#[tokio::test]
#[ignore = "manual installed Claude Code no-Prompt catalog smoke; requires LOOM_CLAUDE_RUNTIME_ENABLED=1 and native authentication"]
async fn claude_catalog_real_runtime_smoke() {
    // LOOM 自有决定（Claude 禁用，2026-11-18）：这条手工探测只在显式 opt-in
    // （经渠道网关的 Claude 端点）时才有意义，默认策略下必须没有任何 Claude 进程。
    assert!(
        rovai_core::runtime_platform_admission::claude_runtime_enabled_by_policy_opt_in(),
        "Claude Code is disabled by product policy; set {}=1 only for the gateway endpoint",
        rovai_core::runtime_platform_admission::CLAUDE_RUNTIME_ENABLED_ENV
    );
    let executable =
        find_adapter(AdapterKind::ClaudeCodeCli).expect("Claude Code must be installed");
    let probe = claude_code_capability_probe_at(&executable, None, None, &[]).await;
    assert_eq!(
        probe.result.status,
        AgentRuntimeProbeStatus::Ready,
        "{:?}",
        probe.result.failure
    );
    assert!(
        probe
            .result
            .capabilities
            .iter()
            .any(|value| value == CLAUDE_MODEL_CATALOG_CAPABILITY)
    );
    assert!(probe.models.len() > 1);
    println!(
        "Claude Code {:?}: {} selectable models",
        probe.result.reported_version,
        probe.models.len() - 1
    );
}
